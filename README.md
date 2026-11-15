# 🚀 Cine Ultimate — Backend Serverless (Vercel + Supabase + Mercado Pago PIX)

Backend pronto para deploy na **Vercel** com suporte nativo a HTTPS, banco de dados **Supabase** (região `sa-east-1` / São Paulo) e geração automática de pagamentos PIX via **Mercado Pago API**.

---

## 🔒 Arquitetura Limpa (Zero Inchaço no Supabase)
Conforme solicitado, o banco no Supabase armazena **estritamente o essencial**:
- ✅ `pix_payments`: Histórico e status das transações PIX (R$ 29,00 atual + transição R$ 10,00).
- ✅ `user_entitlements`: Liberação do acesso e plano por Gmail.
- ✅ `auth.users`: Autenticação e senhas seguras dos usuários.
- ❌ **Sem inchaço**: Histórico de reprodução, biblioteca pessoal e configurações continuam salvos de forma privada no próprio aparelho do usuário.

---

## 📦 Como Subir na Vercel (Em 2 Minutos)

### Opção 1: Pelo Painel Web da Vercel (Recomendado)
1. Crie um repositório no seu GitHub (de preferência privado) contendo os arquivos desta pasta `vercel-backend` (ou o projeto como um todo apontando para a pasta raiz `vercel-backend`).
2. Acesse [vercel.com](https://vercel.com) e clique em **"Add New"** → **"Project"**.
3. Importe o repositório.
4. Em **Environment Variables**, adicione as seguintes variáveis (valores locais no seu `.env`, nunca versionar chaves reais no GitHub):

| Nome da Variável | Valor |
| :--- | :--- |
| `MP_ACCESS_TOKEN` | `<seu-access-token-mercado-pago>` |
| `MP_BASE_URL` | `https://api.mercadopago.com` |
| `PLAN_ID` | `plano_unico_29` |
| `PLAN_NAME` | `Plano Acesso Completo Cine Ultimate` |
| `PLAN_AMOUNT` | `29.00` |
| `SUPABASE_URL` | `https://<seu-projeto>.supabase.co` |
| `SUPABASE_ANON_KEY` | `<sua-supabase-anon-key>` |
| `SUPABASE_SERVICE_ROLE_KEY` | `<sua-supabase-service-role-key>` |

5. Clique em **Deploy**! A Vercel vai gerar seu domínio seguro gratuito, por exemplo:
   `https://cine-ultimate-api.vercel.app`

---

### Opção 2: Pela Linha de Comando (Vercel CLI)
Abra o terminal dentro da pasta `vercel-backend` e rode:
```bash
npx vercel
```
Siga as instruções na tela e depois promova para produção com:
```bash
npx vercel --prod
```

---

## 📡 Rotas Disponíveis na API (HTTPS)

| Método | Rota | Descrição |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Verifica se o servidor e o Supabase estão online. |
| `POST` | `/api/pix/create` | Gera a cobrança PIX de R$ 29,00 no Mercado Pago e registra no Supabase. |
| `GET` | `/api/pix/status?paymentId={id}&email={email}` | Consulta status do pagamento em tempo real. |
| `POST` | `/api/pix/webhook` | Webhook oficial do Mercado Pago para confirmação automática. |
| `POST` | `/api/auth/register` | Cria a conta do usuário no Supabase Auth **apenas se o PIX estiver aprovado**. |
| `POST` | `/api/auth/login` | Faz login com Gmail e senha conferindo se o acesso está ativo. |
| `GET` | `/api/auth/me` | Retorna os dados do usuário autenticado e status do plano. |

