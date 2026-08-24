require('dotenv').config();

const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const TIPOS_IMAGEM_PERMITIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOADS_DIR),
        filename: (req, file, cb) => {
            const nomeUnico = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`;
            cb(null, nomeUnico);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!TIPOS_IMAGEM_PERMITIDOS.includes(file.mimetype)) {
            return cb(new Error('Tipo de arquivo não permitido. Use JPG, PNG, GIF ou WEBP.'));
        }
        cb(null, true);
    }
});

// CONFIGURAÇÕES DO DISCORD BOT & OAUTH2 (vêm todas do .env — nunca hardcode segredos aqui)
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

// LISTA DE IDs (ou usernames) COM ACESSO AO PAINEL ADMIN — configurada em ADMIN_IDS no .env
const ADMINS_AUTORIZADOS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => id.trim().toLowerCase())
    .filter(Boolean);

const DATA_FILE = path.join(__dirname, 'data.json');

function lerDados() {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const dados = JSON.parse(raw);

    // Migração leve para bases de dados criadas antes destes campos existirem
    if (!dados.membros) dados.membros = {};
    if (!dados.spoilers) {
        dados.spoilers = dados.spoiler
            ? [{
                id: 1,
                texto: dados.spoiler.texto,
                imagem: dados.spoiler.imagem || null,
                meta: dados.spoiler.meta,
                reagiram: dados.spoiler.reagiram || [],
                autor: 'Equipe Vilões Community',
                data: new Date().toISOString()
            }]
            : [];
        delete dados.spoiler;
        if (!dados.proximoId.spoilers) dados.proximoId.spoilers = dados.spoilers.length + 1;
    }

    return dados;
}

function salvarDados(dados) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dados, null, 2), 'utf-8');
}

const PONTOS_POR_ACAO = { sugestoes: 5, votos: 1, reacoes: 1, parcerias: 2 };

function registrarAtividade(dados, user, campo) {
    const id = user.id;
    if (!dados.membros[id]) {
        dados.membros[id] = { nome: '', avatar: null, sugestoes: 0, votos: 0, reacoes: 0, parcerias: 0, pontos: 0 };
    }
    const membro = dados.membros[id];
    membro.nome = user.global_name || user.username;
    membro.avatar = user.avatar || null;
    membro[campo] += 1;
    membro.pontos += PONTOS_POR_ACAO[campo] || 1;
}

function ehAdmin(user) {
    if (!user) return false;
    return ADMINS_AUTORIZADOS.includes(String(user.id).toLowerCase()) ||
        ADMINS_AUTORIZADOS.includes(String(user.username || '').toLowerCase());
}

function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ success: false, error: 'Faça login com sua conta do Discord para continuar.' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ success: false, error: 'Faça login com sua conta do Discord para continuar.' });
    }
    if (!ehAdmin(req.session.user)) {
        return res.status(403).json({ success: false, error: 'Você não tem permissão para acessar o Painel Admin.' });
    }
    next();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ================== AUTENTICAÇÃO ==================

// ROTA: Redireciona para o Login do Discord
app.get('/api/auth/login', (req, res) => {
    const authorizeUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(authorizeUrl);
});

// ROTA: Callback da Autenticação Discord
app.get('/api/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI,
                scope: 'identify',
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.redirect('/');

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userResponse.json();

        req.session.user = userData;
        res.redirect('/');
    } catch (err) {
        console.error('Erro na autenticação:', err);
        res.redirect('/');
    }
});

// ROTA: Retorna dados do Usuário Logado
app.get('/api/user', (req, res) => {
    if (req.session.user) {
        const user = req.session.user;
        res.json({
            loggedIn: true,
            user: { ...user, isAdmin: ehAdmin(user) }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// ROTA: Logout
app.get('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// ================== NOTÍCIAS ==================

app.get('/api/noticias', (req, res) => {
    const dados = lerDados();
    res.json(dados.noticias.sort((a, b) => new Date(b.data) - new Date(a.data)));
});

app.post('/api/admin/noticias', requireAdmin, (req, res) => {
    const { titulo, texto, tag, imagem } = req.body;
    if (!titulo || !texto) {
        return res.status(400).json({ success: false, error: 'Título e texto são obrigatórios.' });
    }

    const dados = lerDados();
    const noticia = {
        id: dados.proximoId.noticias++,
        titulo: String(titulo).trim(),
        texto: String(texto).trim(),
        tag: (tag && String(tag).trim()) || 'Novo Aviso',
        imagem: (imagem && String(imagem).trim()) || null,
        autor: req.session.user.global_name || req.session.user.username,
        data: new Date().toISOString()
    };
    dados.noticias.push(noticia);
    salvarDados(dados);
    res.json({ success: true, noticia });
});

app.delete('/api/admin/noticias/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const dados = lerDados();
    dados.noticias = dados.noticias.filter(n => n.id !== id);
    salvarDados(dados);
    res.json({ success: true });
});

// ================== SUGESTÕES ==================

app.get('/api/sugestoes', (req, res) => {
    const dados = lerDados();
    const userId = req.session.user ? req.session.user.id : null;
    const sugestoes = dados.sugestoes
        .map(s => ({ ...s, meuVoto: userId ? (s.votantes[userId] || 0) : 0 }))
        .sort((a, b) => b.votos - a.votos);
    res.json(sugestoes);
});

app.post('/api/sugestoes', requireAuth, (req, res) => {
    const { titulo, texto } = req.body;
    if (!titulo || !texto) {
        return res.status(400).json({ success: false, error: 'Título e descrição são obrigatórios.' });
    }

    const dados = lerDados();
    const sugestao = {
        id: dados.proximoId.sugestoes++,
        titulo: String(titulo).trim(),
        texto: String(texto).trim(),
        autor: req.session.user.global_name || req.session.user.username,
        autorId: req.session.user.id,
        votos: 0,
        votantes: {},
        data: new Date().toISOString()
    };
    dados.sugestoes.push(sugestao);
    registrarAtividade(dados, req.session.user, 'sugestoes');
    salvarDados(dados);
    res.json({ success: true, sugestao });
});

app.post('/api/sugestoes/:id/votar', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const voto = Number(req.body.voto);
    if (voto !== 1 && voto !== -1) {
        return res.status(400).json({ success: false, error: 'Voto inválido.' });
    }

    const dados = lerDados();
    const sugestao = dados.sugestoes.find(s => s.id === id);
    if (!sugestao) return res.status(404).json({ success: false, error: 'Sugestão não encontrada.' });

    const userId = req.session.user.id;
    const votoAtual = sugestao.votantes[userId] || 0;

    if (votoAtual === voto) {
        sugestao.votos -= voto;
        delete sugestao.votantes[userId];
    } else {
        sugestao.votos += voto - votoAtual;
        sugestao.votantes[userId] = voto;
        registrarAtividade(dados, req.session.user, 'votos');
    }

    salvarDados(dados);
    res.json({ success: true, votos: sugestao.votos, meuVoto: sugestao.votantes[userId] || 0 });
});

app.delete('/api/admin/sugestoes/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const dados = lerDados();
    dados.sugestoes = dados.sugestoes.filter(s => s.id !== id);
    salvarDados(dados);
    res.json({ success: true });
});

// ================== PARCERIAS ==================

app.post('/api/parcerias', (req, res) => {
    const { nome, link, desc } = req.body;
    if (!nome || !link || !desc) {
        return res.status(400).json({ success: false, error: 'Preencha todos os campos.' });
    }

    const dados = lerDados();
    const parceria = {
        id: dados.proximoId.parcerias++,
        nome: String(nome).trim(),
        link: String(link).trim(),
        desc: String(desc).trim(),
        solicitanteId: req.session.user ? req.session.user.id : null,
        solicitanteNome: req.session.user ? (req.session.user.global_name || req.session.user.username) : 'Anônimo',
        status: 'pendente',
        data: new Date().toISOString()
    };
    dados.parcerias.push(parceria);
    if (req.session.user) registrarAtividade(dados, req.session.user, 'parcerias');
    salvarDados(dados);
    res.json({ success: true, parceria });
});

app.get('/api/admin/parcerias', requireAdmin, (req, res) => {
    const dados = lerDados();
    res.json(dados.parcerias.sort((a, b) => new Date(b.data) - new Date(a.data)));
});

app.patch('/api/admin/parcerias/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!['pendente', 'aprovado', 'rejeitado'].includes(status)) {
        return res.status(400).json({ success: false, error: 'Status inválido.' });
    }

    const dados = lerDados();
    const parceria = dados.parcerias.find(p => p.id === id);
    if (!parceria) return res.status(404).json({ success: false, error: 'Solicitação não encontrada.' });

    parceria.status = status;
    salvarDados(dados);
    res.json({ success: true, parceria });
});

// ================== SPOILERS ==================

app.get('/api/spoilers', (req, res) => {
    const dados = lerDados();
    const userId = req.session.user ? req.session.user.id : null;
    const spoilers = dados.spoilers
        .map(s => ({
            id: s.id,
            texto: s.texto,
            imagem: s.imagem,
            meta: s.meta,
            autor: s.autor,
            data: s.data,
            reacoes: s.reagiram.length,
            reagi: userId ? s.reagiram.includes(userId) : false
        }))
        .sort((a, b) => new Date(b.data) - new Date(a.data));
    res.json(spoilers);
});

app.post('/api/admin/spoilers', requireAdmin, (req, res) => {
    const { texto, meta, imagem } = req.body;
    if (!texto) return res.status(400).json({ success: false, error: 'Texto do spoiler é obrigatório.' });

    const dados = lerDados();
    const spoiler = {
        id: dados.proximoId.spoilers++,
        texto: String(texto).trim(),
        imagem: (imagem && String(imagem).trim()) || null,
        meta: Number(meta) || 20,
        reagiram: [],
        autor: req.session.user.global_name || req.session.user.username,
        data: new Date().toISOString()
    };
    dados.spoilers.push(spoiler);
    salvarDados(dados);
    res.json({ success: true, spoiler });
});

app.delete('/api/admin/spoilers/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const dados = lerDados();
    dados.spoilers = dados.spoilers.filter(s => s.id !== id);
    salvarDados(dados);
    res.json({ success: true });
});

app.post('/api/spoilers/:id/reagir', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const dados = lerDados();
    const spoiler = dados.spoilers.find(s => s.id === id);
    if (!spoiler) return res.status(404).json({ success: false, error: 'Spoiler não encontrado.' });

    const userId = req.session.user.id;
    const idx = spoiler.reagiram.indexOf(userId);

    if (idx === -1) {
        spoiler.reagiram.push(userId);
        registrarAtividade(dados, req.session.user, 'reacoes');
    } else {
        spoiler.reagiram.splice(idx, 1);
    }

    salvarDados(dados);
    res.json({ success: true, reacoes: spoiler.reagiram.length, reagi: idx === -1 });
});

// ================== UPLOAD DE IMAGENS ==================

app.post('/api/admin/upload', requireAdmin, upload.single('imagem'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Nenhuma imagem enviada.' });
    }
    res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

// ================== MEMBROS ATIVOS ==================

app.get('/api/membros/ranking', (req, res) => {
    const dados = lerDados();
    const ranking = Object.entries(dados.membros)
        .map(([id, m]) => ({ id, ...m }))
        .filter(m => m.pontos > 0)
        .sort((a, b) => b.pontos - a.pontos)
        .slice(0, 5);
    res.json(ranking);
});

// ================== STATUS ONLINE ==================

app.get('/api/online', async (req, res) => {
    try {
        const response = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}?with_counts=true`, {
            headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
        });

        if (!response.ok) {
            return res.status(502).json({ success: false, error: 'Não foi possível obter os dados do servidor Discord.' });
        }

        const guild = await response.json();
        res.json({
            success: true,
            nome: guild.name,
            membros: guild.approximate_member_count,
            online: guild.approximate_presence_count
        });
    } catch (err) {
        console.error('Erro ao buscar status online:', err);
        res.status(500).json({ success: false, error: 'Erro interno ao buscar status online.' });
    }
});

// Middleware de erro (captura falhas de upload: tipo inválido, arquivo grande demais, etc.)
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message === 'Tipo de arquivo não permitido. Use JPG, PNG, GIF ou WEBP.') {
        return res.status(400).json({ success: false, error: err.message });
    }
    console.error(err);
    res.status(500).json({ success: false, error: 'Erro interno no servidor.' });
});

app.listen(PORT, () => {
    console.log(`>>> Servidor rodando na porta ${PORT}`);
    if (ADMINS_AUTORIZADOS.length === 0) {
        console.warn('>>> Aviso: ADMIN_IDS não configurado no .env — ninguém terá acesso ao Painel Admin.');
    }
});
