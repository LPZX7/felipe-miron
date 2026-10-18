import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {DateTime} from 'luxon';
import {db,initDb,isPg,settings,publicServices,bookingDetails} from './db.js';

const app=express(); app.set('trust proxy',1);
const PORT=Number(process.env.PORT)||3000;
const ZONE='America/Sao_Paulo';
const IS_PROD=process.env.NODE_ENV==='production';
const SECRET=process.env.SESSION_SECRET||'';
const USER=process.env.ADMIN_USERNAME||'';
const PASS=process.env.ADMIN_PASSWORD||'';
const LOGIN_READY=Boolean(USER&&PASS&&SECRET.length>=32&&PASS.length>=10);
const HASH=LOGIN_READY?bcrypt.hashSync(PASS,11):null;
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
class AppError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const fail=(msg,status)=>{throw new AppError(msg,status)};
const text=(s,max=150)=>String(s??'').trim().slice(0,max);
const isoDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(String(s))&&DateTime.fromISO(s,{zone:ZONE}).isValid;
const timeRe=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const uuid=()=>crypto.randomUUID();
const isoFromLocal=(date,hhmm)=>DateTime.fromISO(`${date}T${hhmm}:00`,{zone:ZONE});
const ACTIVE=['confirmed','pending','completed'];
function startEnd(date,time,duration){const start=isoFromLocal(date,time); return {start,start_at:start.toUTC().toISO(),end_at:start.plus({minutes:duration}).toUTC().toISO()};}
function toPublicBooking(a){const {manage_token,...safe}=a;return safe;}
function isWithinNotice(date,config){const d=DateTime.fromISO(date,{zone:ZONE});const now=DateTime.now().setZone(ZONE);
  return d.startOf('day')>=now.startOf('day')&&d.startOf('day')<=now.startOf('day').plus({days:config.advance_days});
}
async function getSlots(date,service,conn=db,{exceptId=null}={}){
  const config=await settings();
  if(!isoDate(date)||!isWithinNotice(date,config)||!service?.active)return [];
  const day=DateTime.fromISO(date,{zone:ZONE});const entry=config.hours[day.weekday%7];
  if(!entry?.open||!timeRe.test(entry.start)||!timeRe.test(entry.end))return [];
  const opening=isoFromLocal(date,entry.start),closing=isoFromLocal(date,entry.end);
  if(!opening.isValid||!closing.isValid||closing<=opening)return [];
  const bookings=await conn('bookings').where({local_date:date}).whereIn('status',ACTIVE).modify(q=>{if(exceptId)q.whereNot('id',exceptId)}).select('start_at','end_at');
  const blocks=await conn('blocks').where({local_date:date}).select('start_at','end_at');
  const taken=[...bookings,...blocks].map(x=>({start:DateTime.fromISO(x.start_at),end:DateTime.fromISO(x.end_at)}));
  const minTime=DateTime.now().setZone(ZONE).plus({minutes:config.min_notice});
  const result=[];
  for(let candidate=opening;candidate.plus({minutes:service.duration})<=closing;candidate=candidate.plus({minutes:config.slot_interval})){
    const last=candidate.plus({minutes:service.duration});
    if(candidate<minTime)continue;
    if(taken.some(t=>candidate< t.end && last>t.start))continue;
    result.push(candidate.toFormat('HH:mm'));
  }
  return result;
}
async function dayLock(trx,date){if(isPg)await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))',[date]);}
async function transactBooking(data,{admin=false}={}){
  const service=await db('services').where({id:text(data.serviceId,40)}).first();
  if(!service||!service.active)fail('Serviço indisponível.',404);
  const date=data.date, time=data.time;
  if(!isoDate(date)||!timeRe.test(String(time)))fail('Data ou horário inválido.');
  if(text(data.name,100).length<2)fail('Informe seu nome completo.');
  const phone=String(data.phone||'').replace(/\D/g,'');
  if(phone.length<10||phone.length>13)fail('Informe um telefone válido com DDD.');
  if(text(data.notes,500).length>500)fail('Observação muito longa.');
  return db.transaction(async trx=>{
    await dayLock(trx,date);
    const available=await getSlots(date,service,trx);
    if(!available.includes(time))fail('Este horário não está mais disponível. Escolha outro.',409);
    const id=uuid(),token=crypto.randomBytes(32).toString('hex'),now=new Date().toISOString();
    const dates=startEnd(date,time,service.duration);
    const booking={id,customer_name:text(data.name,100),customer_phone:phone,notes:text(data.notes,500)||null,service_id:service.id,
      start_at:dates.start_at,end_at:dates.end_at,local_date:date,status:'confirmed',manage_token:token,created_at:now,updated_at:now};
    await trx('bookings').insert(booking);
    return {id,manageToken:token,status:'confirmed',name:booking.customer_name,phone,service:service.name,date,time,duration:service.duration};
  });
}
app.use(express.json({limit:'20kb'}));app.use(cookieParser());
app.use((req,res,next)=>{
  if(['POST','PATCH','PUT','DELETE'].includes(req.method)&&req.headers.origin){
    try{if(new URL(req.headers.origin).host!==req.get('host'))return res.status(403).json({error:'Origem da solicitação não permitida.'});}
    catch{return res.status(403).json({error:'Origem inválida.'});}
  }
  next();
});
const bookingLimit=rateLimit({windowMs:60*60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Limite de tentativas atingido. Tente novamente mais tarde.'}});
const loginLimit=rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Muitas tentativas. Aguarde 15 minutos.'}});
function auth(req,res,next){try{const t=req.cookies.leo_admin;if(!t)return res.status(401).json({error:'É necessário entrar no painel.'});
 const decoded=jwt.verify(t,SECRET,{algorithms:['HS256']});if(decoded.role!=='admin')throw Error('Not admin');next();}
 catch{return res.status(401).json({error:'Sessão expirada. Entre novamente.'});}}
app.get('/api/health',asyncRoute(async(req,res)=>{await db.raw('select 1');res.json({ok:true,timezone:ZONE});}));
app.get('/api/business',asyncRoute(async(req,res)=>{
 const config=await settings();res.json({name:'Léo Cortes Barbearia',address:'Av. Armando Sestini, 520, Caieiras - SP, 07716-210',
  phone:'5511986955798',email:'leocortescaieiras@gmail.com',instagram:'leocortescaieiras',
  services:await publicServices(),hours:config.hours,advanceDays:config.advance_days,timezone:ZONE});
}));
app.get('/api/availability',asyncRoute(async(req,res)=>{
 const service=await db('services').where({id:text(req.query.serviceId,40),active:true}).first();
 if(!service)return res.status(404).json({error:'Serviço não encontrado.'});
 if(!isoDate(req.query.date))fail('Data inválida.');
 res.json({date:req.query.date,serviceId:service.id,slots:await getSlots(req.query.date,service)});
}));
app.post('/api/bookings',bookingLimit,asyncRoute(async(req,res)=>res.status(201).json(await transactBooking(req.body))));
app.get('/api/bookings/:id',bookingLimit,asyncRoute(async(req,res)=>{
  const row=await db('bookings').where({id:req.params.id,manage_token:text(req.query.token,100)}).first();
  if(!row)fail('Agendamento não encontrado.',404);
  const service=await db('services').where({id:row.service_id}).first();
  res.json({booking:{...toPublicBooking(row),service_name:service?.name}});
}));
app.post('/api/bookings/:id/cancel',bookingLimit,asyncRoute(async(req,res)=>{
  const token=text(req.body.token,100);if(token.length<32)fail('Código de cancelamento inválido.',403);
  const result=await db('bookings').where({id:req.params.id,manage_token:token}).first();
  if(!result)fail('Agendamento não encontrado.',404);
  if(result.status==='canceled')return res.json({ok:true});
  if(result.status==='completed'||result.status==='no_show')fail('Este atendimento já foi encerrado.');
  if(DateTime.fromISO(result.start_at)<DateTime.now().plus({hours:1}))fail('Cancelamento online permitido com pelo menos 1 hora de antecedência. Entre em contato com a barbearia.');
  await db('bookings').where({id:result.id,manage_token:token}).update({status:'canceled',updated_at:new Date().toISOString()});res.json({ok:true});
}));
app.post('/api/auth/login',loginLimit,asyncRoute(async(req,res)=>{
  if(!LOGIN_READY)return res.status(503).json({error:'Acesso administrativo ainda não configurado no servidor.'});
  const validName=typeof req.body.username==='string'&&req.body.username===USER;
  const validPass=typeof req.body.password==='string'&&bcrypt.compareSync(req.body.password,HASH);
  if(!validName||!validPass)return res.status(401).json({error:'Usuário ou senha incorretos.'});
  const token=jwt.sign({role:'admin'},SECRET,{algorithm:'HS256',expiresIn:'12h'});
  res.cookie('leo_admin',token,{httpOnly:true,sameSite:'lax',secure:IS_PROD,maxAge:12*60*60*1000,path:'/'}).json({ok:true});
}));
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('leo_admin',{path:'/'}).json({ok:true});});
app.get('/api/auth/me',auth,(req,res)=>res.json({authenticated:true}));
app.get('/api/admin/bookings',auth,asyncRoute(async(req,res)=>{
  if(!isoDate(req.query.date))fail('Selecione uma data válida.');
  const list=await bookingDetails(db('bookings')).where('bookings.local_date',req.query.date).orderBy('bookings.start_at');
  res.json({bookings:list.map(toPublicBooking)});
}));
app.post('/api/admin/bookings',auth,asyncRoute(async(req,res)=>res.status(201).json(await transactBooking(req.body,{admin:true}))));
app.patch('/api/admin/bookings/:id/status',auth,asyncRoute(async(req,res)=>{
  const status=req.body.status;
  if(!['confirmed','completed','canceled','no_show'].includes(status))fail('Status inválido.');
  const row=await db('bookings').where({id:req.params.id}).first();if(!row)fail('Agendamento não encontrado.',404);
  if(row.status==='completed'&&status==='confirmed')fail('Atendimento concluído não pode voltar a confirmado.');
  if(['canceled','no_show'].includes(row.status)&&status==='confirmed'){
    // Prevent reactivating a slot that another client booked.
    await db.transaction(async trx=>{
      await dayLock(trx,row.local_date);
      const conflicts=await trx('bookings').where({local_date:row.local_date}).whereIn('status',ACTIVE).whereNot('id',row.id)
        .where('start_at','<',row.end_at).where('end_at','>',row.start_at).first();
      const block=await trx('blocks').where({local_date:row.local_date}).where('start_at','<',row.end_at).where('end_at','>',row.start_at).first();
      if(conflicts||block)fail('Não é possível reativar: horário ocupado.',409);
      await trx('bookings').where({id:row.id}).update({status,updated_at:new Date().toISOString()});
    });
  }else await db('bookings').where({id:row.id}).update({status,updated_at:new Date().toISOString()});
  res.json({ok:true});
}));
app.get('/api/admin/services',auth,asyncRoute(async(req,res)=>res.json({services:await db('services').orderBy('position').orderBy('name')})));
function parseService(data){
  const name=text(data.name,120),description=text(data.description,500),duration=Number(data.duration);
  if(name.length<2||!Number.isInteger(duration)||duration<10||duration>480)fail('Nome e duração (10–480 minutos) são obrigatórios.');
  const price=data.price===''||data.price===null||data.price===undefined?null:Number(data.price);
  if(price!==null&&(!Number.isFinite(price)||price<0||price>100000))fail('Preço inválido.');
  return {name,description,duration,price_cents:price===null?null:Math.round(price*100),active:Boolean(data.active),position:Number.isInteger(Number(data.position))?Number(data.position):0};
}
app.post('/api/admin/services',auth,asyncRoute(async(req,res)=>{
 const service={id:uuid(),...parseService(req.body),created_at:new Date().toISOString()};await db('services').insert(service);res.status(201).json({service});
}));
app.patch('/api/admin/services/:id',auth,asyncRoute(async(req,res)=>{
 const updated=await db('services').where({id:req.params.id}).update(parseService(req.body));if(!updated)fail('Serviço não encontrado.',404);res.json({ok:true});
}));
app.get('/api/admin/settings',auth,asyncRoute(async(req,res)=>res.json({settings:await settings()})));
app.patch('/api/admin/settings',auth,asyncRoute(async(req,res)=>{
 const hours=req.body.hours;
 if(!hours||typeof hours!=='object')fail('Horários inválidos.');
 for(let n=0;n<7;n++){
  const h=hours[n];if(!h||typeof h.open!=='boolean'||!timeRe.test(h.start)||!timeRe.test(h.end)||h.start>=h.end)fail(`Horário inválido no dia ${n}.`);
 }
 const slot=Number(req.body.slot_interval),notice=Number(req.body.min_notice),days=Number(req.body.advance_days);
 if(![10,15,20,30,60].includes(slot)||!Number.isInteger(notice)||notice<0||notice>1440||!Number.isInteger(days)||days<1||days>180)fail('Parâmetros de agenda inválidos.');
 await db('settings').where({id:1}).update({hours:JSON.stringify(hours),slot_interval:slot,min_notice:notice,advance_days:days});res.json({ok:true});
}));
app.get('/api/admin/blocks',auth,asyncRoute(async(req,res)=>{
 if(!isoDate(req.query.date))fail('Data inválida.');res.json({blocks:await db('blocks').where({local_date:req.query.date}).orderBy('start_at')});
}));
app.post('/api/admin/blocks',auth,asyncRoute(async(req,res)=>{
 const {date,start,end}=req.body;if(!isoDate(date)||!timeRe.test(start)||!timeRe.test(end)||start>=end)fail('Confira a data e o intervalo do bloqueio.');
 const a=isoFromLocal(date,start).toUTC().toISO(),b=isoFromLocal(date,end).toUTC().toISO();
 await db.transaction(async trx=>{
  await dayLock(trx,date);
  const occupied=await trx('bookings').where({local_date:date}).whereIn('status',ACTIVE).where('start_at','<',b).where('end_at','>',a).first();
  if(occupied)fail('Existe um agendamento nesse intervalo. Cancele ou remaneje primeiro.',409);
  await trx('blocks').insert({id:uuid(),local_date:date,start_at:a,end_at:b,reason:text(req.body.reason,150),created_at:new Date().toISOString()});
 });res.status(201).json({ok:true});
}));
app.delete('/api/admin/blocks/:id',auth,asyncRoute(async(req,res)=>{await db('blocks').where({id:req.params.id}).del();res.json({ok:true});}));
app.use('/api',(req,res)=>res.status(404).json({error:'Rota não encontrada.'}));
const root=path.dirname(fileURLToPath(import.meta.url));
const dist=path.resolve(root,'../dist');
if(fs.existsSync(dist)){app.use(express.static(dist,{index:false}));app.get('*',(req,res)=>res.sendFile(path.join(dist,'index.html')));}
app.use((err,req,res,next)=>{console.error('[API]',err.message);if(res.headersSent)return next(err);res.status(err.status||500).json({error:err.status?err.message:'Ocorreu um erro no servidor. Tente novamente.'});});
try{await initDb();app.listen(PORT,()=>{
  console.log(`Léo Cortes: http://localhost:${PORT} - banco ${isPg?'PostgreSQL':'SQLite'}`);
  if(!LOGIN_READY)console.warn('ATENÇÃO: Configure ADMIN_USERNAME, ADMIN_PASSWORD (min. 10 caracteres) e SESSION_SECRET (min. 32). Painel bloqueado.');
  if(IS_PROD&&!isPg)console.warn('ATENÇÃO: SQLite em disco efêmero pode perder agendamentos. Configure DATABASE_URL PostgreSQL em produção.');
});}catch(e){console.error('Falha na inicialização:',e);process.exit(1);}