/**
 * Cloudflare Worker — Área do Cliente (Poliana Rebouças)
 *
 * Faz duas coisas para o portal:
 *   1) Guarda e entrega arquivos no Cloudflare R2 (só quem tem acesso à conversa/processo)
 *   2) Envia avisos por e-mail (Brevo) quando há nova mensagem ou andamento
 *
 * Segurança: o Worker NÃO guarda senhas nem contas. Ele repassa o "token" do usuário
 * logado ao Firestore. Se as regras do Firestore permitirem ao usuário ler aquela
 * conversa/processo, o Worker permite o arquivo; se não, nega.
 *
 * Variáveis (Settings → Variables do Worker):
 *   FIREBASE_PROJECT_ID  = webpagepoliana
 *   ALLOWED_ORIGIN       = https://polianareboucasadv.github.io
 *   SITE_URL             = https://polianareboucasadv.github.io/webpage/cliente.html
 *   LAWYER_EMAIL         = e-mail que recebe os avisos (ex.: polireboucas@gmail.com)
 *   SENDER_EMAIL         = remetente verificado no Brevo
 *   SENDER_NAME          = Poliana Rebouças Advocacia
 *   BREVO_API_KEY        = (Secret) chave da API do Brevo
 * Binding R2:
 *   FILES                = bucket R2 (ex.: portal-poliana)
 */

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB por arquivo
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|msi|js|vbs|ps1|jar|apk|dll|sh)$/i;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const reply = (body, status = 200, extra = {}) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body),
        { status, headers: { 'Content-Type': 'application/json', ...cors, ...extra } });

    try {
      if (url.pathname === '/health') return reply({ ok: true, r2: !!env.FILES, mail: !!env.BREVO_API_KEY });

      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!token) return reply({ erro: 'Não autenticado.' }, 401);

      // ---------- Enviar arquivo ----------
      if (url.pathname === '/upload' && req.method === 'POST') {
        const scope = url.searchParams.get('scope'), id = url.searchParams.get('id');
        const name = (url.searchParams.get('name') || 'arquivo').slice(0, 120);
        if (!['c', 'p'].includes(scope) || !/^[A-Za-z0-9_-]{5,64}$/.test(id || '')) return reply({ erro: 'Pedido inválido.' }, 400);
        if (BLOCKED_EXT.test(name)) return reply({ erro: 'Tipo de arquivo não permitido.' }, 400);
        const len = Number(req.headers.get('Content-Length') || 0);
        if (!len || len > MAX_BYTES) return reply({ erro: 'Arquivo vazio ou maior que 15 MB.' }, 413);
        const doc = await readDoc(env, token, scope === 'c' ? `chats/${id}` : `processos/${id}`);
        if (!doc) return reply({ erro: 'Sem permissão.' }, 403);
        const safe = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_');
        const key = `${scope}/${id}/${crypto.randomUUID()}-${safe}`;
        const type = (req.headers.get('Content-Type') || 'application/octet-stream').slice(0, 100);
        await env.FILES.put(key, req.body, { httpMetadata: { contentType: type }, customMetadata: { nome: name } });
        return reply({ key, nome: name, tamanho: len, tipo: type });
      }

      // ---------- Baixar arquivo ----------
      if (url.pathname === '/file' && req.method === 'GET') {
        const key = url.searchParams.get('key') || '';
        const m = key.match(/^([cp])\/([A-Za-z0-9_-]{5,64})\/[^/]+$/);
        if (!m) return reply({ erro: 'Pedido inválido.' }, 400);
        const doc = await readDoc(env, token, m[1] === 'c' ? `chats/${m[2]}` : `processos/${m[2]}`);
        if (!doc) return reply({ erro: 'Sem permissão.' }, 403);
        const obj = await env.FILES.get(key);
        if (!obj) return reply({ erro: 'Arquivo não encontrado.' }, 404);
        const nome = obj.customMetadata?.nome || key.split('/').pop();
        return new Response(obj.body, { headers: {
          'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(nome)}`,
          'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', ...cors } });
      }

      // ---------- Avisar por e-mail ----------
      if (url.pathname === '/notify' && req.method === 'POST') {
        const { kind, id } = await req.json();
        if (!['msg', 'andamento'].includes(kind) || !/^[A-Za-z0-9_-]{5,64}$/.test(id || '')) return reply({ erro: 'Pedido inválido.' }, 400);
        const sub = tokenSub(token);
        const doc = await readDoc(env, token, kind === 'msg' ? `chats/${id}` : `processos/${id}`);
        if (!doc) return reply({ erro: 'Sem permissão.' }, 403);
        const f = doc.fields || {};
        const when = Date.parse(f[kind === 'msg' ? 'ultimaMsgAt' : 'atualizadoAt']?.timestampValue || 0);
        if (!when || Date.now() - when > 120000) return reply({ ok: true, enviado: false, motivo: 'antigo' });
        // no máximo 1 e-mail a cada 45 s por conversa/processo
        const rlKey = `rl/${kind}/${id}`, last = await env.FILES.get(rlKey);
        if (last && Date.now() - Number(await last.text()) < 45000) return reply({ ok: true, enviado: false, motivo: 'limite' });
        await env.FILES.put(rlKey, String(Date.now()));

        const clienteUid = f.clienteUid?.stringValue;
        const deCliente = sub === clienteUid;
        let to, nomeDest, assunto, linha;
        const titulo = f.titulo?.stringValue || (f.numero?.stringValue ? `Processo ${f.numero.stringValue}` : 'Conversa');
        if (deCliente) { // cliente escreveu → avisa a advogada
          if (kind !== 'msg') return reply({ erro: 'Não permitido.' }, 403);
          const cli = await readDoc(env, token, `clientes/${clienteUid}`);
          const nome = cli?.fields?.nome?.stringValue || 'Cliente';
          to = env.LAWYER_EMAIL; nomeDest = 'Dra. Poliana';
          assunto = `Nova mensagem de ${nome}`;
          linha = `${esc(nome)} enviou uma nova mensagem em <b>${esc(titulo)}</b>.`;
        } else { // advogada escreveu → avisa o cliente (se ele aceitar e-mails)
          const cli = await readDoc(env, token, `clientes/${clienteUid}`);
          if (!cli) return reply({ ok: true, enviado: false, motivo: 'sem cliente' });
          if (cli.fields?.notifEmail?.booleanValue === false) return reply({ ok: true, enviado: false, motivo: 'desativado' });
          to = cli.fields?.email?.stringValue; nomeDest = cli.fields?.nome?.stringValue || '';
          if (kind === 'msg') { assunto = 'Nova mensagem da sua advogada'; linha = `Você recebeu uma nova mensagem em <b>${esc(titulo)}</b>.`; }
          else { assunto = 'Atualização no seu processo'; linha = `Há uma atualização no seu processo <b>${esc(titulo)}</b>${f.ultimoAviso?.stringValue ? `: ${esc(f.ultimoAviso.stringValue)}` : '.'}`; }
        }
        if (!to || !env.BREVO_API_KEY) return reply({ ok: true, enviado: false, motivo: 'sem destinatário/chave' });
        const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e3d9b8;padding:24px">
          <p style="color:#a98a35;letter-spacing:2px;font-size:12px;margin:0 0 12px">POLIANA REBOUÇAS · ADVOCACIA</p>
          <p style="font-size:15px;color:#222">${nomeDest ? `Olá, ${esc(nomeDest)}.<br><br>` : ''}${linha}</p>
          <p style="margin:24px 0"><a href="${env.SITE_URL}" style="background:#c9a84c;color:#0d1821;padding:12px 22px;text-decoration:none;font-weight:bold;font-size:13px">ABRIR O PORTAL</a></p>
          <p style="font-size:11px;color:#888">Por segurança, o conteúdo das mensagens só aparece dentro do portal. Você pode desativar estes avisos em Perfil.</p></div>`;
        const r = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sender: { name: env.SENDER_NAME || 'Poliana Rebouças Advocacia', email: env.SENDER_EMAIL },
            to: [{ email: to, name: nomeDest || undefined }], subject: assunto, htmlContent: html })
        });
        return reply({ ok: r.ok, enviado: r.ok });
      }

      return reply({ erro: 'Rota não encontrada.' }, 404);
    } catch (e) {
      return reply({ erro: 'Erro interno.' }, 500);
    }
  }
};

/** Lê um documento do Firestore COMO o usuário (as regras do Firestore decidem o acesso). */
async function readDoc(env, token, path) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}
/** uid do usuário (o token já foi validado pelo Firestore na leitura acima). */
function tokenSub(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).user_id || ''; } catch { return ''; }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
