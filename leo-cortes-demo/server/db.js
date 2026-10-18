import 'dotenv/config';
import knex from 'knex';
import fs from 'node:fs';
import path from 'node:path';

const postgres = Boolean(process.env.DATABASE_URL);
if (!postgres) fs.mkdirSync(path.join(process.cwd(), 'data'), {recursive:true});
export const db = knex(postgres ? {
  client:'pg', connection:{connectionString:process.env.DATABASE_URL, ssl: process.env.PGSSL === 'require' ? {rejectUnauthorized:false} : undefined}, pool:{min:0,max:10}
} : {client:'better-sqlite3', connection:{filename:path.join(process.cwd(),'data','barbearia.sqlite')}, useNullAsDefault:true, pool:{min:1,max:1}});
export const isPg = postgres;

export const defaultHours = {
  0:{open:false,start:'09:00',end:'18:00'},
  1:{open:true,start:'09:00',end:'20:00'},
  2:{open:true,start:'09:00',end:'20:00'},
  3:{open:true,start:'09:00',end:'20:00'},
  4:{open:true,start:'09:00',end:'20:00'},
  5:{open:true,start:'09:00',end:'20:00'},
  6:{open:true,start:'09:00',end:'18:00'}
};
const now = () => new Date().toISOString();
export async function initDb(){
  if (!await db.schema.hasTable('settings')) {
    await db.schema.createTable('settings', t=>{
      t.integer('id').primary(); t.text('hours').notNullable(); t.integer('slot_interval').notNullable().defaultTo(30);
      t.integer('min_notice').notNullable().defaultTo(60); t.integer('advance_days').notNullable().defaultTo(45);
    });
  }
  if(!await db.schema.hasTable('services')){
    await db.schema.createTable('services',t=>{
      t.string('id',40).primary(); t.string('name',120).notNullable(); t.text('description'); t.integer('duration').notNullable();
      t.integer('price_cents'); t.boolean('active').notNullable().defaultTo(true); t.integer('position').notNullable().defaultTo(0);
      t.text('created_at').notNullable();
    });
  }
  if(!await db.schema.hasTable('bookings')){
    await db.schema.createTable('bookings',t=>{
      t.string('id',40).primary(); t.string('customer_name',100).notNullable(); t.string('customer_phone',25).notNullable();
      t.text('notes'); t.string('service_id',40).notNullable().references('id').inTable('services');
      t.text('start_at').notNullable(); t.text('end_at').notNullable(); t.string('local_date',10).notNullable();
      t.string('status',20).notNullable().defaultTo('confirmed'); t.string('manage_token',100).notNullable();
      t.text('created_at').notNullable(); t.text('updated_at').notNullable();
      t.index(['local_date','status']);
    });
  }
  if(!await db.schema.hasTable('blocks')){
    await db.schema.createTable('blocks',t=>{
      t.string('id',40).primary(); t.string('local_date',10).notNullable(); t.text('start_at').notNullable();
      t.text('end_at').notNullable(); t.string('reason',150); t.text('created_at').notNullable(); t.index(['local_date']);
    });
  }
  if(!await db('settings').where({id:1}).first()){
    await db('settings').insert({id:1,hours:JSON.stringify(defaultHours),slot_interval:30,min_notice:60,advance_days:45});
  }
  if(!(await db('services').count('* as total').first()).total){
    await db('services').insert([
      {id:'corte',name:'Corte de cabelo',description:'Corte personalizado, com acabamento caprichado.',duration:40,price_cents:null,active:true,position:1,created_at:now()},
      {id:'barba',name:'Barba',description:'Modelagem e cuidado da barba.',duration:30,price_cents:null,active:true,position:2,created_at:now()},
      {id:'combo',name:'Corte + barba',description:'Seu visual completo em um só atendimento.',duration:70,price_cents:null,active:true,position:3,created_at:now()},
      {id:'coloracao',name:'Coloração de cabelo',description:'Coloração e acabamento.',duration:90,price_cents:null,active:true,position:4,created_at:now()}
    ]);
  }
}
export async function settings(){let row=await db('settings').where({id:1}).first(); return {...row,hours:JSON.parse(row.hours)};}
export async function publicServices(){return db('services').where({active:true}).orderBy('position').orderBy('name');}
export const bookingDetails = q => q.join('services','services.id','bookings.service_id').select('bookings.*','services.name as service_name','services.duration','services.price_cents');