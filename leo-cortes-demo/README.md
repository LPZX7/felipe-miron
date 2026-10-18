# Léo Cortes — Agendamento Online

Sistema de agendamento próprio, em português, com página pública e painel protegido por senha. **Sem Lovable**.

## Recursos

- Agendamento online por serviço, data, horário, nome e celular; confirmação imediata.
- Disponibilidade real: evita sobreposição considerando a duração dos serviços, bloqueios, reservas existentes e antecedência mínima.
- Link pessoal para consultar ou cancelar um agendamento até 1 hora antes da reserva.
- Painel em `/admin`: agenda diária, status (confirmado, concluído, cancelado, não compareceu), cadastro manual, serviços, preços, dias e horários, bloqueios.
- Botões do WhatsApp **abrem** mensagens pré-preenchidas. Nenhuma mensagem é enviada automaticamente (integração com API oficial pode ser adicionada).
- Layout responsivo para celular e computador.
- Horário de referência: `America/Sao_Paulo`.

## Requisitos

Node.js **22 ou superior**, npm e acesso à Internet na primeira instalação para baixar as dependências.

## Como iniciar localmente

1. No terminal, entre na pasta deste projeto.
2. Copie `.env.example` para `.env`.
3. Defina um usuário de administração, senha forte (mín. 10 caracteres) e `SESSION_SECRET` aleatória com pelo menos 32 caracteres.
4. Execute:

```bash
npm install
npm run build
npm start
```

5. Acesse `http://localhost:3000` para clientes e `http://localhost:3000/admin` para a equipe.

Modo de desenvolvimento, com recarregamento automático: `npm run dev` (página em `http://localhost:5173`).

**Importante:** Não existe senha administrativa padrão. Se faltar configuração, o login fica bloqueado. Nunca envie seu arquivo `.env` para terceiros ou para repositórios públicos.

## Hospedagem e banco de dados

- **Desenvolvimento/local**: SQLite em `data/barbearia.sqlite`, arquivo persistido no disco do computador.
- **Produção**: configure `DATABASE_URL` para PostgreSQL gerenciado e persistente (Render Postgres, Supabase ou equivalente). O projeto seleciona PostgreSQL automaticamente ao detectar a variável.
- No Render, crie um Web Service Node.js com `Build Command` igual a `npm install && npm run build`, `Start Command` igual a `npm start`, `NODE_ENV=production`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET` e `DATABASE_URL` em Environment.
- Configure `PGSSL=require` **somente se** o provedor do seu PostgreSQL exigir TLS e use uma cadeia de certificados adequada. Para maior segurança, prefira validar certificados fornecidos pelo provedor em produção.
- A implantação em produção **não** deve usar SQLite no disco efêmero do Render: agendamentos podem desaparecer em reinicializações ou redeploys.

## Dados pré-configurados

**Confirmados pelas imagens fornecidas:** nome Léo Cortes Barbearia; endereço Av. Armando Sestini, 520, Caieiras/SP; WhatsApp (11) 98695-5798; Instagram `@leocortescaieiras`; serviço de coloração; sexta-feira 09:00–20:00; sábado abre às 09:00.

**Valores iniciais de exemplo (NÃO confirmados):** lista adicional de serviços, suas durações, seg–qui 09:00–20:00, sábado 09:00–18:00, domingo fechado. Esses dados precisam ser revisados no painel **antes de divulgar o sistema**. Os preços permanecem sem valor, mostrando “Valor sob consulta” até o administrador preenchê-los.

## Segurança e limitações

- Sessão HTTP-only de 12h, autenticação por usuário e senha de ambiente, criptografia bcrypt na verificação, limitação de tentativas e checagem de origem em requisições mutáveis.
- Identificadores e códigos de gerenciamento individuais (guarde o link de cancelamento).
- O banco usa transações para reservar horários; em PostgreSQL há bloqueio transacional por data para proteger de reservas simultâneas.
- Modelo atual considera **uma cadeira/profissional atendendo por horário**. Para múltiplos barbeiros, estender o esquema com `barber_id` e disponibilidade separada.
- Não processa pagamentos, não dispara mensagens automaticamente e não possui calendário externo integrado.
- Para uso comercial, ative HTTPS no provedor e faça backups regulares do banco, cuide dos dados pessoais conforme a LGPD e tenha política de privacidade visível aos clientes.

## Arquivos principais

- `src/main.jsx` e `src/style.css`: interface pública e painel administrativo.
- `server/index.js`: API, segurança, agenda e autenticação.
- `server/db.js`: persistência e estrutura do banco, criada automaticamente.

## Comandos

```bash
npm run dev    # desenvolvimento
npm run build  # gera a interface de produção em dist/
npm start      # inicia o servidor na porta 3000 (ou PORT)
npm run check  # verifica a sintaxe do servidor
```

Desenvolvido como projeto independente e editável. Sem dependência do Lovable.