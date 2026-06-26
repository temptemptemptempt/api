const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { createCanvas, loadImage } = require('canvas');
const https = require('https');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');
const app = express();
const PORT = 8080;

// Cache para tokens
const cache = new NodeCache({ stdTTL: 8 * 60 * 60 });

// ============================================
// SISREG III - CONFIGURAÇÃO (SEM PROXY)
// ============================================

console.log('🔧 SISREG III - Conexão direta (sem proxy)');

// Credenciais do SISREG III
const CREDENCIAIS_SISREG = [
    { usuario: '420930JEAN', senha: '01052008jean' },
    { usuario: 'ANACINTIA.SANTOSsol', senha: '290952ma' },
    { usuario: 'jlandim', senha: '@@Jcll240396' },
];

// Cache de sessões do SISREG
let sessoesAtivas = new Map();
let sessionPool = [];
let currentSessionIndex = 0;
let lastHealthCheck = Date.now();

// ============================================
// FUNÇÕES SISREG III (SEM PROXY)
// ============================================

async function fazerLoginSISREG(usuario, senha) {
    try {
        console.log(`🔑 Tentando login SISREG: ${usuario}`);
        
        const hash = crypto.createHash('sha256')
            .update(senha.toUpperCase(), 'utf8')
            .digest('hex');

        const params = new URLSearchParams();
        params.append('usuario', usuario);
        params.append('senha_256', hash);
        params.append('etapa', 'ACESSO');
        params.append('logout', '');

        console.log(`📤 Enviando requisição para ${usuario}...`);
        
        const response = await axios.post(
            'https://sisregiii.saude.gov.br/',
            params.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                    'Accept-Language': 'pt-BR,pt;q=0.9',
                    'Referer': 'https://sisregiii.saude.gov.br/',
                    'Origin': 'https://sisregiii.saude.gov.br'
                },
                maxRedirects: 0,
                validateStatus: status => status < 500,
                timeout: 30000
            }
        );

        console.log(`📥 Resposta para ${usuario}: Status ${response.status}`);

        if (response.status === 302) {
            const location = response.headers.location || '';
            console.log(`📍 Location: ${location}`);
            
            if (location.includes('/cgi-bin/index')) {
                const cookies = response.headers['set-cookie'];
                let cookieString = '';
                if (cookies) {
                    cookieString = cookies.map(c => c.split(';')[0]).join('; ');
                    console.log(`🍪 Cookies recebidos: ${cookieString}`);
                }
                
                const client = axios.create({
                    baseURL: 'https://sisregiii.saude.gov.br',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                        'Accept-Language': 'pt-BR,pt;q=0.9',
                        'Cookie': cookieString,
                        'Referer': 'https://sisregiii.saude.gov.br/cgi-bin/index'
                    },
                    maxRedirects: 5,
                    timeout: 30000
                });
                
                console.log(`🔍 Testando sessão para ${usuario}...`);
                
                const testResponse = await client.get('/cgi-bin/cadweb50?standalone=1', {
                    timeout: 15000,
                    validateStatus: status => status < 500
                });
                
                console.log(`📊 Teste para ${usuario}: Status ${testResponse.status}`);
                
                const isValid = testResponse.status === 200 && 
                               !testResponse.data.includes('login') && 
                               !testResponse.data.includes('ACESSO') && 
                               !testResponse.data.includes('senha_256');
                
                if (isValid) {
                    console.log(`✅ Sessão SISREG válida para ${usuario}!`);
                    return { 
                        success: true, 
                        client, 
                        cookieString, 
                        usuario,
                        createdAt: Date.now()
                    };
                } else {
                    console.log(`❌ Sessão inválida para ${usuario} - página de login detectada`);
                }
            }
        } else {
            console.log(`❌ Status não é 302: ${response.status}`);
        }
        
        return { success: false, usuario, motivo: 'Falha no login' };
        
    } catch (error) {
        console.error(`❌ Erro login SISREG ${usuario}:`, error.message);
        return { success: false, usuario, motivo: error.message };
    }
}

async function inicializarSessaoPoolSISREG() {
    console.log('\n🔐 Inicializando pool de sessões SISREG...\n');
    
    const sessoes = [];
    
    for (let i = 0; i < CREDENCIAIS_SISREG.length; i++) {
        const cred = CREDENCIAIS_SISREG[i];
        if (!cred.senha || cred.senha === '') {
            console.log(`⚠️ Senha vazia para ${cred.usuario}, pulando...`);
            continue;
        }
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`🔄 Testando ${cred.usuario}...`);
        console.log(`${'='.repeat(50)}`);
        
        const resultado = await fazerLoginSISREG(cred.usuario, cred.senha);
        
        if (resultado.success) {
            const sessao = {
                client: resultado.client,
                cookieString: resultado.cookieString,
                usuario: cred.usuario,
                ultimoUso: Date.now(),
                criacao: Date.now(),
                indice: i,
                valid: true
            };
            sessoes.push(sessao);
            sessoesAtivas.set(cred.usuario, sessao);
            console.log(`✅ Sessão SISREG estabelecida com ${cred.usuario}!`);
        } else {
            console.log(`❌ Falha ao estabelecer sessão SISREG com ${cred.usuario}: ${resultado.motivo}`);
        }
        
        if (i < CREDENCIAIS_SISREG.length - 1) {
            console.log(`⏳ Aguardando 2 segundos antes da próxima tentativa...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    if (sessoes.length === 0) {
        console.log('\n❌ Não foi possível estabelecer nenhuma sessão SISREG!');
        console.log('💡 Verifique se:');
        console.log('   - As credenciais estão corretas');
        console.log('   - O site sisregiii.saude.gov.br está acessível');
        return false;
    }
    
    sessionPool = sessoes;
    console.log(`\n✅ Pool SISREG criado com ${sessionPool.length} sessões ativas\n`);
    sessionPool.forEach(s => {
        console.log(`   👤 ${s.usuario} - Válida: ${s.valid}`);
    });
    return true;
}

async function verificarSessaoSISREG(sessao) {
    if (!sessao || !sessao.client) return false;
    
    try {
        const response = await sessao.client.get('/cgi-bin/cadweb50?standalone=1', { 
            timeout: 10000,
            validateStatus: status => status < 500
        });
        
        const isValid = response.status === 200 && 
                       !response.data.includes('login') && 
                       !response.data.includes('ACESSO') && 
                       !response.data.includes('senha_256');
        
        sessao.valid = isValid;
        
        if (!isValid) {
            console.log(`⚠️ Sessão SISREG ${sessao.usuario} expirou!`);
        }
        
        return isValid;
    } catch (error) {
        console.log(`⚠️ Erro ao verificar sessão SISREG ${sessao.usuario}: ${error.message}`);
        sessao.valid = false;
        return false;
    }
}

async function manterSessoesAtivasSISREG() {
    console.log('🔄 Realizando manutenção das sessões SISREG...');
    
    for (let i = 0; i < sessionPool.length; i++) {
        const sessao = sessionPool[i];
        
        if (!sessao.valid || (Date.now() - sessao.criacao) > 25 * 60 * 1000) {
            console.log(`🔄 Renovando sessão SISREG ${sessao.usuario}...`);
            
            const cred = CREDENCIAIS_SISREG[sessao.indice];
            const novaSessao = await fazerLoginSISREG(cred.usuario, cred.senha);
            
            if (novaSessao.success) {
                sessionPool[i] = {
                    client: novaSessao.client,
                    cookieString: novaSessao.cookieString,
                    usuario: cred.usuario,
                    ultimoUso: Date.now(),
                    criacao: Date.now(),
                    indice: sessao.indice,
                    valid: true
                };
                sessoesAtivas.set(cred.usuario, sessionPool[i]);
                console.log(`✅ Sessão SISREG ${cred.usuario} renovada!`);
            } else {
                console.log(`❌ Falha ao renovar ${cred.usuario}, removendo do pool`);
                sessionPool.splice(i, 1);
                i--;
            }
        } else {
            await verificarSessaoSISREG(sessao);
        }
    }
    
    if (sessionPool.length === 0) {
        console.log('⚠️ Pool SISREG vazio, reinicializando...');
        await inicializarSessaoPoolSISREG();
    }
    
    lastHealthCheck = Date.now();
}

function getNextSessionSISREG() {
    if (sessionPool.length === 0) return null;
    
    const validSessions = sessionPool.filter(s => s.valid === true);
    
    if (validSessions.length === 0) return null;
    
    currentSessionIndex = (currentSessionIndex + 1) % validSessions.length;
    const sessao = validSessions[currentSessionIndex];
    sessao.ultimoUso = Date.now();
    
    return sessao;
}

async function consultarPacienteSISREG(consulta, tentativas = 0) {
    if (tentativas > 5) {
        throw new Error('Múltiplas falhas de consulta SISREG');
    }
    
    let sessao = getNextSessionSISREG();
    
    if (!sessao) {
        console.log('⚠️ Nenhuma sessão SISREG disponível, recriando pool...');
        await inicializarSessaoPoolSISREG();
        sessao = getNextSessionSISREG();
        
        if (!sessao) {
            throw new Error('Nenhuma sessão SISREG disponível após recriação');
        }
    }
    
    try {
        const consultData = new URLSearchParams();
        consultData.append('nu_cns', consulta);
        consultData.append('nome_paciente', '');
        consultData.append('nome_mae', '');
        consultData.append('dt_nascimento', '');
        consultData.append('uf_nasc', '');
        consultData.append('mun_nasc', '');
        consultData.append('uf_res', '');
        consultData.append('mun_res', '');
        consultData.append('sexo', '');
        consultData.append('etapa', 'DETALHAR');
        consultData.append('url', '');
        consultData.append('standalone', '1');
        
        const response = await sessao.client.post('/cgi-bin/cadweb50?standalone=1', consultData.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://sisregiii.saude.gov.br/cgi-bin/cadweb50?standalone=1',
                'Origin': 'https://sisregiii.saude.gov.br',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 20000
        });
        
        if (response.data.includes('ACESSO') && response.data.includes('senha_256')) {
            console.log(`⚠️ Sessão SISREG ${sessao.usuario} expirou durante consulta`);
            sessao.valid = false;
            return consultarPacienteSISREG(consulta, tentativas + 1);
        }
        
        if (response.data.includes('Nenhum paciente encontrado')) {
            return { erro: 'Paciente não encontrado no SISREG' };
        }
        
        return response.data;
        
    } catch (error) {
        console.log(`⚠️ Erro na consulta SISREG com ${sessao.usuario}: ${error.message}`);
        sessao.valid = false;
        
        if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET') {
            return consultarPacienteSISREG(consulta, tentativas + 1);
        }
        
        throw error;
    }
}

function extrairDadosSISREG(html) {
    const $ = cheerio.load(html);
    const dados = {};
    
    if (html.includes('Nenhum paciente encontrado') || html.includes('não encontrado')) {
        return { erro: 'Paciente não encontrado no SISREG' };
    }
    
    const celulas = [];
    $('table.table_listagem').first().find('td').each((i, cell) => {
        let texto = $(cell).text().trim();
        texto = texto.replace(/[\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (texto && !texto.includes('Tipo Telefone') && !texto.includes('DDD') && !texto.includes('Número')) {
            celulas.push(texto);
        }
    });
    
    for (let i = 0; i < celulas.length; i++) {
        const cell = celulas[i];
        
        if (cell === 'CNS:') dados.cns = celulas[i + 1];
        if (cell === 'Nome:') dados.nome = celulas[i + 2];
        if (cell === 'Nome da Mãe:') {
            dados.nome_mae = celulas[i + 2];
            if (celulas[i + 3] && !celulas[i + 3].includes('Nome do')) dados.nome_pai = celulas[i + 3];
        }
        if (cell === 'Sexo:') {
            dados.sexo = celulas[i + 2];
            if (celulas[i + 3] && celulas[i + 3] !== '---') dados.raca = celulas[i + 3];
        }
        if (cell === 'Data de Nascimento:') {
            dados.data_nascimento = celulas[i + 2];
            if (celulas[i + 3] && celulas[i + 3] !== '---') dados.tipo_sanguineo = celulas[i + 3];
        }
        if (cell === 'Nacionalidade:') {
            dados.nacionalidade = celulas[i + 2];
            if (celulas[i + 3] && celulas[i + 3] !== '---') dados.municipio_nascimento = celulas[i + 3];
        }
        if (cell === 'Endereço:') {
            const endereco = celulas[i + 2];
            if (endereco && endereco !== '---') dados.endereco = endereco;
        }
        if (cell === 'Bairro:') {
            dados.bairro = celulas[i + 2];
            if (celulas[i + 3] && celulas[i + 3] !== '---') dados.cep = celulas[i + 3];
        }
        if (cell === 'Município de Residência:') {
            dados.municipio_residencia = celulas[i + 2];
            if (celulas[i + 3] && celulas[i + 3] !== '---') dados.uf_residencia = celulas[i + 3];
        }
        if (cell === 'CPF:') dados.cpf = celulas[i + 1];
    }
    
    const telefones = [];
    $('table.table_listagem table').each((i, table) => {
        $(table).find('tr').each((j, row) => {
            const cols = $(row).find('td');
            if (cols.length === 3) {
                const tipo = $(cols[0]).text().trim();
                const ddd = $(cols[1]).text().trim().replace(/[()]/g, '');
                const numero = $(cols[2]).text().trim();
                if (tipo && numero && tipo !== 'Tipo Telefone' && tipo !== 'Telefone') {
                    telefones.push({ tipo, ddd, numero });
                }
            }
        });
    });
    
    if (telefones.length > 0) dados.telefones = telefones;
    
    return dados;
}

// ============================================
// CONFIGURAÇÃO IDMA (FOTO MA) - SEM PROXY
// ============================================

const CONFIG_IDMA = {
    baseUrl: 'https://sso-idma.si.valid.com.br:8443',
    authUrl: 'https://sso-idma.si.valid.com.br:8443/auth/realms/valid/protocol/openid-connect/auth',
    loginUrl: 'https://sso-idma.si.valid.com.br:8443/auth/realms/valid/login-actions/authenticate',
    tokenUrl: 'https://sso-idma.si.valid.com.br:8443/auth/realms/valid/protocol/openid-connect/token',
    consultaUrl: 'https://spd-idma.si.valid.com.br:4443/webapispd/api/v1/processo/prontuario',
    clientId: 'Valid.Spd',
    redirectUri: 'https://spd-idma.si.valid.com.br:4443/spd/consulta-prontuario',
    username: 'givanildo.medina',
    password: 'Th3oeolivia'
};

const httpsAgentIDMA = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true
});

let accessTokenIDMA = null;
let tokenExpiresAtIDMA = null;
let sessionCookiesIDMA = [];
let isLoggedInIDMA = false;

// ============== FUNÇÃO PARA EXTRAIR PARÂMETROS ==============
function extractParamsIDMA(html) {
    const params = {};
    const $ = cheerio.load(html);
    
    $('input[type="hidden"]').each((i, el) => {
        const name = $(el).attr('name');
        const value = $(el).attr('value');
        if (name && value) {
            params[name] = value;
        }
    });

    $('script').each((i, el) => {
        const content = $(el).html() || '';
        const sessionMatch = content.match(/session_code["']?\s*[:=]\s*["']([^"']+)["']/);
        if (sessionMatch && !params.session_code) params.session_code = sessionMatch[1];
        const execMatch = content.match(/execution["']?\s*[:=]\s*["']([^"']+)["']/);
        if (execMatch && !params.execution) params.execution = execMatch[1];
        const tabMatch = content.match(/tab_id["']?\s*[:=]\s*["']([^"']+)["']/);
        if (tabMatch && !params.tab_id) params.tab_id = tabMatch[1];
    });

    if (!params.session_code || !params.execution) {
        const matches = html.match(/(session_code|execution|tab_id|client_id)=([^&"'\s]+)/g);
        if (matches) {
            matches.forEach(m => {
                const [key, value] = m.split('=');
                if (key === 'session_code' && !params.session_code) params.session_code = value;
                if (key === 'execution' && !params.execution) params.execution = value;
                if (key === 'tab_id' && !params.tab_id) params.tab_id = value;
                if (key === 'client_id' && !params.client_id) params.client_id = value;
            });
        }
    }

    const formAction = $('form').attr('action');
    if (formAction) params.action = formAction;

    return params;
}

// ============== FAZER LOGIN ==============
async function fazerLoginIDMA() {
    try {
        console.log('\n🔐 Iniciando login IDMA...');

        const state = uuidv4();
        const nonce = uuidv4();
        
        const authParams = {
            client_id: CONFIG_IDMA.clientId,
            redirect_uri: CONFIG_IDMA.redirectUri,
            response_type: 'code',
            scope: 'openid',
            state: state,
            nonce: nonce
        };

        const authUrl = `${CONFIG_IDMA.authUrl}?${new URLSearchParams(authParams).toString()}`;

        let response = await axios.get(authUrl, {
            httpsAgent: httpsAgentIDMA,
            maxRedirects: 0,
            validateStatus: (status) => status === 200 || status === 302 || status === 303,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });

        let cookies = [];
        let html = response.data;
        let params = {};

        if (response.headers['set-cookie']) {
            cookies = response.headers['set-cookie'];
        }

        if (response.status === 302 || response.status === 303) {
            const location = response.headers.location;
            const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
            
            const follow = await axios.get(location, {
                httpsAgent: httpsAgentIDMA,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Cookie': cookieStr
                }
            });
            
            if (follow.headers['set-cookie']) {
                cookies = [...cookies, ...follow.headers['set-cookie']];
            }
            
            html = follow.data;
            params = extractParamsIDMA(html);
        } else {
            params = extractParamsIDMA(html);
        }

        if (!params.session_code || !params.execution) {
            throw new Error('Não foi possível extrair parâmetros do formulário');
        }

        const loginData = {
            username: CONFIG_IDMA.username,
            password: CONFIG_IDMA.password,
            credentialId: '',
            client_id: params.client_id || CONFIG_IDMA.clientId,
            tab_id: params.tab_id || '0Z_lYKTCW-E',
            execution: params.execution,
            session_code: params.session_code
        };

        const loginUrl = params.action || CONFIG_IDMA.loginUrl;
        const formData = new URLSearchParams();
        Object.keys(loginData).forEach(key => {
            formData.append(key, loginData[key]);
        });

        const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

        const loginHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': CONFIG_IDMA.baseUrl,
            'Connection': 'keep-alive',
            'Referer': authUrl,
            'Cookie': cookieStr,
            'Upgrade-Insecure-Requests': '1'
        };

        const loginResponse = await axios.post(loginUrl, formData.toString(), {
            httpsAgent: httpsAgentIDMA,
            headers: loginHeaders,
            maxRedirects: 0,
            validateStatus: (status) => status === 302 || status === 200 || status === 303 || status === 400
        });

        if (loginResponse.headers['set-cookie']) {
            cookies = [...cookies, ...loginResponse.headers['set-cookie']];
        }

        if (loginResponse.status === 400) {
            throw new Error('❌ Erro no login: ' + (loginResponse.data.match(/error-message[^>]*>([^<]+)/)?.[1] || 'Credenciais inválidas'));
        }

        if (loginResponse.status === 200) {
            const htmlContent = loginResponse.data;
            if (htmlContent.includes('Invalid username or password')) {
                throw new Error('❌ Usuário ou senha inválidos!');
            }
        }

        let code = null;
        let location = loginResponse.headers.location;

        if (location) {
            const codeMatch = location.match(/[?&]code=([^&]+)/);
            if (codeMatch) {
                code = decodeURIComponent(codeMatch[1]);
            }
        }

        if (!code && loginResponse.status === 200) {
            const codeMatch = loginResponse.data.match(/[?&]code=([^&"'\s]+)/);
            if (codeMatch) {
                code = codeMatch[1];
            }
        }

        if (!code) {
            throw new Error('❌ Não foi possível obter código de autorização');
        }

        const tokenData = {
            grant_type: 'authorization_code',
            code: code,
            client_id: CONFIG_IDMA.clientId,
            redirect_uri: CONFIG_IDMA.redirectUri
        };

        const tokenResponse = await axios.post(CONFIG_IDMA.tokenUrl, new URLSearchParams(tokenData).toString(), {
            httpsAgent: httpsAgentIDMA,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookies.map(c => c.split(';')[0]).join('; ')
            }
        });

        accessTokenIDMA = tokenResponse.data.access_token;
        tokenExpiresAtIDMA = Date.now() + (tokenResponse.data.expires_in * 1000);
        sessionCookiesIDMA = cookies;
        isLoggedInIDMA = true;

        console.log('✅ Login IDMA realizado com sucesso!');
        console.log(`⏰ Token expira em ${tokenResponse.data.expires_in} segundos`);

        return accessTokenIDMA;

    } catch (error) {
        console.error('❌ Erro no login IDMA:', error.message);
        isLoggedInIDMA = false;
        throw error;
    }
}

// ============== GARANTIR TOKEN VÁLIDO ==============
async function ensureTokenIDMA() {
    if (!isLoggedInIDMA || !accessTokenIDMA || Date.now() >= tokenExpiresAtIDMA - 60000) {
        console.log('🔄 Token IDMA expirado, renovando...');
        await fazerLoginIDMA();
    }
    return accessTokenIDMA;
}

// ============== CONSULTAR ==============
async function consultarProntuarioIDMA(cpf) {
    const token = await ensureTokenIDMA();
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
        throw new Error('CPF inválido. Deve conter 11 dígitos');
    }

    const consultaData = {
        cpf: cpfLimpo,
        dataNascimento: '',
        nome: '',
        nomeMae: '',
        nomePai: '',
        protocolo: '',
        rg: '',
        tipografico: ''
    };

    console.log(`📡 Consultando CPF no IDMA: ${cpfLimpo}`);

    const cookieStr = sessionCookiesIDMA.map(c => c.split(';')[0]).join('; ');

    const response = await axios.post(
        CONFIG_IDMA.consultaUrl,
        consultaData,
        {
            httpsAgent: httpsAgentIDMA,
            headers: {
                'Content-Type': 'application/json;charset=utf-8',
                'Accept': 'application/json, text/plain, */*',
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
                'Origin': 'https://spd-idma.si.valid.com.br:4443',
                'Referer': 'https://spd-idma.si.valid.com.br:4443/spd/consulta-prontuario',
                'Cookie': cookieStr
            },
            timeout: 30000
        }
    );

    return response.data;
}

// ============================================
// ROTA FOTO MA (IDMA)
// ============================================

app.get('/fotoma', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({
            erro: 'CPF não fornecido',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (!validarCPF(cpfLimpo)) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    try {
        console.log(`📸 Consultando FOTO MA (IDMA) para CPF: ${cpfLimpo}`);
        
        const resultado = await consultarProntuarioIDMA(cpfLimpo);
        
        if (!resultado) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Nenhum resultado encontrado para este CPF no IDMA',
                cpf_consultado: cpfLimpo
            });
        }
        
        res.json({
            sucesso: true,
            fonte: 'IDMA (Valid)',
            cpf_consultado: cpfLimpo,
            dados: resultado,
            consulta_realizada_em: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Erro na rota /fotoma:', error.message);
        res.status(500).json({
            sucesso: false,
            erro: 'Erro ao consultar IDMA',
            mensagem: error.message,
            cpf_consultado: cpfLimpo
        });
    }
});
// ============================================
// CONFIGURAÇÃO GERAL DAS APIS
// ============================================

// Configuração base das APIs
const BASE_PARAMS = {
    token: '1c47093716d898f265f107de8796fbabe97c5ea796df6b72'
};

// Configuração das APIs por tipo de consulta
const APIS = {
    cpf: {
        RF: {
            url: 'https://api.eyerofgodfinder.com/brasil/cpf',
            params: { ...BASE_PARAMS }
        }
    },
    nome: {
        BR43M: {
            url: 'https://api.eyerofgodfinder.com/brasil/br43malgarnomecompleto',
            params: { ...BASE_PARAMS }
        }
    },
    nome_mae: {
        CARTORIOS_MAE: {
            url: 'https://api.eyerofgodfinder.com/brasil/nomemae',
            params: { ...BASE_PARAMS }
        }
    },
    nome_pai: {
        CARTORIOS_PAI: {
            url: 'https://api.eyerofgodfinder.com/brasil/nomepai',
            params: { ...BASE_PARAMS }
        }
    },
    placa: {
        PLACA_RF1: {
            url: 'https://api.eyerofgodfinder.com/brasil/placa',
            params: { ...BASE_PARAMS }
        }
    },
    bnmp: {
        BNMP: {
            url: 'https://fontedoneymar.discloud.app/bnmp',
            params: { apikey: 'arexaprepararquebra' }
        }
    }
};

// ============================================
// CONFIGURAÇÃO FOTO ES (SISP-ES) - COM HTTPS AGENT
// ============================================
const USER_ES = "18188100773";
const PASS_ES = "s123456*";

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

class FotoEs {
    constructor(user, psw) {
        this.user = user;
        this.psw = psw;
        this.token = null;
        
        this.session = axios.create({
            httpsAgent: httpsAgent,
            maxRedirects: 5,
            timeout: 30000,
            withCredentials: true
        });
        
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://portal.sisp.es.gov.br',
            'Referer': 'https://portal.sisp.es.gov.br/sispes-frontend/xhtml/pesquisa.jsf',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        };
        
        this.cookies = null;
    }

    log(msg) {
        console.log(`[${new Date().toISOString()}] [FOTO-ES] ${msg}`);
    }

    extractCookies(response) {
        const cookies = response.headers['set-cookie'];
        if (cookies) {
            this.cookies = cookies.map(cookie => cookie.split(';')[0]).join('; ');
        }
    }

    async login(retry = true) {
        this.log("LOGIN → iniciando");

        const data = new URLSearchParams();
        data.append('j_username', this.user);
        data.append('j_password', this.psw);
        data.append('submit.x', '193');
        data.append('submit.y', '24');

        try {
            const headers = {
                ...this.headers,
                'Content-Type': 'application/x-www-form-urlencoded',
            };

            if (this.cookies) {
                headers['Cookie'] = this.cookies;
            }

            const response = await this.session.post(
                'https://portal.sisp.es.gov.br/sispes-frontend/xhtml/j_security_check',
                data.toString(),
                { 
                    headers: headers,
                    maxRedirects: 0
                }
            );

            this.extractCookies(response);

            const $ = cheerio.load(response.data);
            let vs = $('input[name="javax.faces.ViewState"]').val();

            if (!vs) {
                vs = $('input[id*="ViewState"]').val();
                if (!vs) {
                    this.log("❌ ViewState não encontrado");
                    return false;
                }
            }

            this.token = vs;
            this.log(`✔ login OK`);
            return true;

        } catch (error) {
            if (error.response && error.response.status === 302) {
                this.log("✔ redirect recebido");
                this.extractCookies(error.response);
                
                try {
                    const mainResponse = await this.session.get(
                        'https://portal.sisp.es.gov.br/sispes-frontend/xhtml/pesquisa.jsf',
                        { 
                            headers: {
                                ...this.headers,
                                'Cookie': this.cookies || ''
                            }
                        }
                    );
                    
                    const $ = cheerio.load(mainResponse.data);
                    const vs = $('input[name="javax.faces.ViewState"]').val();
                    
                    if (vs) {
                        this.token = vs;
                        this.log(`✔ login OK via redirect`);
                        return true;
                    }
                } catch (err) {
                    this.log(`❌ erro após redirect: ${err.message}`);
                }
            }
            
            this.log(`❌ erro no login: ${error.message}`);
            if (retry) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this.login(false);
            }
            return false;
        }
    }

    extractVS(xml) {
        const $ = cheerio.load(xml, { xmlMode: true });
        let viewState = null;
        
        $('update').each((i, el) => {
            const id = $(el).attr('id');
            if (id && id.includes('ViewState')) {
                viewState = $(el).text();
                if (viewState && viewState.length > 10) {
                    return false;
                }
            }
        });
        
        if (!viewState) {
            const cdataMatch = xml.match(/<!\[CDATA\[.*?javax\.faces\.ViewState.*?value="([^"]+)".*?\]\]>/s);
            if (cdataMatch) {
                viewState = cdataMatch[1];
            }
        }
        
        return viewState;
    }

    async consulta(cpf, retry = true) {
        const cpfLimpo = cpf.replace(/\D/g, '');
        this.log(`CONSULTA → ${cpfLimpo}`);

        if (!this.token) {
            this.log("⚠️ sem token, realizando login...");
            if (!await this.login()) {
                return null;
            }
        }

        try {
            const data1 = new URLSearchParams();
            data1.append('pesquisaform', 'pesquisaform');
            data1.append('pesquisaform:paramPesquisa', cpfLimpo);
            data1.append('pesquisaform:btnPesquisar', '');
            data1.append('javax.faces.ViewState', this.token);

            const headers1 = {
                ...this.headers,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': this.cookies || ''
            };

            const r1 = await this.session.post(
                'https://portal.sisp.es.gov.br/sispes-frontend/xhtml/pesquisa.jsf',
                data1.toString(),
                { headers: headers1 }
            );

            let html = r1.data;

            if (html.includes("j_password") || html.includes("login")) {
                this.log("⚠️ sessão expirou");
                if (retry && await this.login()) {
                    return this.consulta(cpf, false);
                }
                return null;
            }

            this.extractCookies(r1);

            const $ = cheerio.load(html);
            
            let tabela = $('#pesquisaform\\:tblPessoas_data');
            if (!tabela.length) {
                tabela = $('table[id*="tblPessoas"] tbody');
            }
            
            if (!tabela.length) {
                this.log("❌ tabela não encontrada");
                return null;
            }

            const linhas = tabela.find('tr');
            if (!linhas.length) {
                this.log("❌ sem resultado");
                return null;
            }

            const cols = linhas.first().find('td');
            if (cols.length < 5) {
                this.log("❌ colunas insuficientes");
                return null;
            }
            
            const nome = cols.eq(1).text().trim();
            const nascimento = cols.eq(2).text().trim();
            const mae = cols.eq(3).text().trim();
            const pai = cols.eq(4).text().trim();

            this.log(`✔ ${nome}`);

            const data2 = new URLSearchParams();
            data2.append('javax.faces.partial.ajax', 'true');
            data2.append('javax.faces.source', 'pesquisaform:tblPessoas');
            data2.append('javax.faces.partial.execute', 'pesquisaform:tblPessoas');
            data2.append('javax.faces.partial.render', 'pesquisaform:tblPessoas');
            data2.append('javax.faces.behavior.event', 'rowToggle');
            data2.append('javax.faces.partial.event', 'rowToggle');
            data2.append('pesquisaform:tblPessoas_rowExpansion', 'true');
            data2.append('pesquisaform:tblPessoas_expandedRowIndex', '0');
            data2.append('pesquisaform', 'pesquisaform');
            data2.append('pesquisaform:paramPesquisa', cpfLimpo);
            data2.append('javax.faces.ViewState', this.token);

            const r2 = await this.session.post(
                'https://portal.sisp.es.gov.br/sispes-frontend/xhtml/pesquisa.jsf',
                data2.toString(),
                { headers: headers1 }
            );

            if (r2.data.includes("<error>") || r2.data.includes("j_password")) {
                this.log("❌ erro STEP 2");
                if (retry && await this.login()) {
                    return this.consulta(cpf, false);
                }
                return null;
            }

            const vs2 = this.extractVS(r2.data);
            const viewStateStep3 = vs2 || this.token;

            const data3 = new URLSearchParams();
            data3.append('javax.faces.partial.ajax', 'true');
            data3.append('javax.faces.source', 'pesquisaform:tblPessoas:0:imgs');
            data3.append('javax.faces.partial.execute', '@all');
            data3.append('javax.faces.partial.render', 'pesquisaform:dlgImagens');
            data3.append('javax.faces.behavior.event', 'action');
            data3.append('javax.faces.partial.event', 'click');
            data3.append('pesquisaform:tblPessoas:0:imgs', 'pesquisaform:tblPessoas:0:imgs');
            data3.append('pesquisaform', 'pesquisaform');
            data3.append('pesquisaform:paramPesquisa', cpfLimpo);
            data3.append('javax.faces.ViewState', viewStateStep3);

            const r3 = await this.session.post(
                'https://portal.sisp.es.gov.br/sispes-frontend/xhtml/pesquisa.jsf',
                data3.toString(),
                { headers: headers1 }
            );

            if (r3.data.includes("<error>")) {
                this.log("⚠️ erro STEP 3, pode não ter imagens");
                return {
                    nome: nome,
                    cpf: cpfLimpo,
                    nascimento: nascimento,
                    mae: mae,
                    pai: pai,
                    foto: null
                };
            }

            let imagens = [];
            const $xml = cheerio.load(r3.data, { xmlMode: true });
            const updates = $xml('update');
            
            for (const update of updates) {
                const content = $xml(update).text();
                const imgRegex = /src="([^"]+)"/g;
                let match;
                
                while ((match = imgRegex.exec(content)) !== null) {
                    let src = match[1];
                    if (src && !src.includes('placeholder')) {
                        imagens.push(src);
                    }
                }
            }
            
            if (imagens.length === 0) {
                const $html = cheerio.load(r3.data);
                $html('img').each((i, img) => {
                    let src = $html(img).attr('src');
                    if (src && !src.includes('placeholder')) {
                        imagens.push(src);
                    }
                });
            }

            this.log(`🔍 encontradas ${imagens.length} imagens`);

            const fotosBase64 = [];
            
            for (const imgSrc of imagens) {
                try {
                    const imgUrl = imgSrc.startsWith('http') ? imgSrc : `https://portal.sisp.es.gov.br${imgSrc}`;
                    
                    const imgResponse = await this.session.get(imgUrl, {
                        headers: {
                            'User-Agent': this.headers['User-Agent'],
                            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                            'Referer': 'https://portal.sisp.es.gov.br/sispes-frontend/xhtml/pesquisa.jsf',
                            'Cookie': this.cookies || ''
                        },
                        responseType: 'arraybuffer'
                    });
                    
                    if (imgResponse.data.length > 5000) {
                        fotosBase64.push(Buffer.from(imgResponse.data).toString('base64'));
                        this.log(`✔ imagem baixada (${imgResponse.data.length} bytes)`);
                    }
                } catch (err) {
                    this.log(`❌ erro ao baixar imagem: ${err.message}`);
                }
            }

            this.log(`✔ fotos válidas: ${fotosBase64.length}`);

            return {
                nome: nome,
                cpf: cpfLimpo,
                nascimento: nascimento,
                mae: mae,
                pai: pai,
                foto: fotosBase64.length > 0 ? fotosBase64[0] : null,
                todas_fotos: fotosBase64
            };

        } catch (error) {
            this.log(`❌ erro na consulta: ${error.message}`);
            return null;
        }
    }
}

// ============================================
// CONFIGURAÇÃO CARTÓRIO MS (RG) - COM SESSÃO PERSISTENTE
// ============================================

const LOGIN_MS = "PPRADO";
const SENHA_MS = "04391732998";
const BASE_URL_MS = "https://iigp.sejusp.ms.gov.br/Cartorios/idNetAPI";

let tokenMS = null;
let tokenExpiresAtMS = null;
let isLoggedInMS = false;
let lastActivityMS = Date.now();
const SESSION_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutos

// Criar sessão axios com keep-alive
const sessionMS = axios.create({
    httpsAgent: httpsAgent,
    timeout: 30000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Charset': 'utf-8',
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=60, max=1000',
        'Referer': 'https://iigp.sejusp.ms.gov.br/Cartorios/idNetCartorio/home.html'
    }
});

async function loginMS(retry = true) {
    console.log(`[${new Date().toISOString()}] [CARTORIO-MS] LOGIN → iniciando`);
    
    const url = `${BASE_URL_MS}/autenticacao/autenticar`;
    const headers = {
        'Content-Type': 'application/json'
    };
    
    const payload = {
        login: LOGIN_MS,
        senha: SENHA_MS,
        estado: "MS"
    };
    
    try {
        const response = await sessionMS.post(url, payload, { headers });
        
        if (response.status !== 200) {
            console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ❌ login falhou - HTTP ${response.status}`);
            return false;
        }
        
        const data = response.data;
        
        if (!data.token) {
            console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ❌ token não encontrado na resposta`);
            return false;
        }
        
        tokenMS = data.token;
        tokenExpiresAtMS = Date.now() + (30 * 60 * 1000); // Token válido por 30 minutos
        isLoggedInMS = true;
        lastActivityMS = Date.now();
        
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ✔ login OK, token obtido`);
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ⏰ Token expira em 30 minutos`);
        return true;
        
    } catch (error) {
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ❌ erro de conexão: ${error.message}`);
        if (retry) {
            console.log(`[${new Date().toISOString()}] [CARTORIO-MS] 🔄 tentando novamente em 2 segundos...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return loginMS(false);
        }
        return false;
    }
}

async function ensureTokenMS() {
    const now = Date.now();
    
    // Verificar se o token expirou ou está perto de expirar (menos de 5 minutos)
    const tokenExpired = !tokenMS || !isLoggedInMS || !tokenExpiresAtMS || (now >= tokenExpiresAtMS - 5 * 60 * 1000);
    
    // Verificar se a sessão está inativa por muito tempo
    const sessionInactive = (now - lastActivityMS) > SESSION_TIMEOUT_MS;
    
    if (tokenExpired || sessionInactive) {
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] 🔄 Token expirado ou inativo, renovando...`);
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] Token expired: ${tokenExpired}, Session inactive: ${sessionInactive}`);
        
        const success = await loginMS();
        if (!success) {
            throw new Error('Falha ao renovar token do Cartório-MS');
        }
        return tokenMS;
    }
    
    // Atualizar última atividade
    lastActivityMS = now;
    return tokenMS;
}

async function consultarPorRG(rg, retry = true) {
    const rgLimpo = rg.replace(/\D/g, '');
    console.log(`[${new Date().toISOString()}] [CARTORIO-MS] CONSULTA RG → ${rgLimpo}`);
    
    try {
        // Garantir token válido antes de cada consulta
        const token = await ensureTokenMS();
        
        const url = `${BASE_URL_MS}/cartorio/obterCidadaoPorRG/${rgLimpo}`;
        const headers = {
            'token': token
        };
        
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] 📡 Enviando requisição...`);
        
        const response = await sessionMS.get(url, { headers });
        
        // Atualizar última atividade
        lastActivityMS = Date.now();
        
        if (response.status === 401) {
            console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ⚠️ token expirado (401), tentando renovar...`);
            if (retry) {
                // Forçar renovação do token
                await loginMS();
                return consultarPorRG(rg, false);
            }
            return null;
        }
        
        if (response.status !== 200) {
            console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ❌ HTTP ${response.status}`);
            return null;
        }
        
        const data = response.data;
        
        if (!data || !data.NumeroPessoa) {
            console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ❌ dados não encontrados`);
            return null;
        }
        
        const resultado = {
            nome: data.Nome || null,
            rg: data.RGAtribuido || null,
            cpf: data.CPF || null,
            nascimento: data.NascimentoAproximado || null,
            mae: data.Mae || null,
            pai: data.Pai || null,
            local_nascimento: data.LocalNascimento || null,
            foto: data.Foto || null,
            assinatura: data.Assinatura || null
        };
        
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ✔ ${resultado.nome} - RG ${resultado.rg}`);
        return resultado;
        
    } catch (error) {
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ❌ erro na consulta: ${error.message}`);
        
        // Se erro de conexão, tenta reconectar
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('ECONNRESET')) {
            console.log(`[${new Date().toISOString()}] [CARTORIO-MS] 🔄 Erro de conexão, tentando reconectar...`);
            if (retry) {
                await loginMS();
                return consultarPorRG(rg, false);
            }
        }
        
        return null;
    }
}

// ============================================
// MANUTENÇÃO AUTOMÁTICA DA SESSÃO MS
// ============================================

// Ping a cada 2 minutos para manter a sessão ativa
setInterval(async () => {
    try {
        if (isLoggedInMS && tokenMS) {
            const now = Date.now();
            const timeToExpire = tokenExpiresAtMS ? tokenExpiresAtMS - now : 0;
            
            // Se o token vai expirar em menos de 5 minutos, renova
            if (timeToExpire < 5 * 60 * 1000) {
                console.log(`[${new Date().toISOString()}] [CARTORIO-MS] 🔄 Renovando token preventivamente...`);
                await loginMS();
            } else {
                // Verifica se a sessão ainda está ativa com um ping
                try {
                    const token = await ensureTokenMS();
                    // Testa com uma consulta simples (RG 00000000) - não vai retornar dados, mas testa a sessão
                    const url = `${BASE_URL_MS}/cartorio/obterCidadaoPorRG/00000000`;
                    const response = await sessionMS.get(url, { 
                        headers: { token: token },
                        timeout: 10000
                    });
                    // Se retornou 200, sessão está ativa
                    if (response.status === 200) {
                        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ✅ Sessão ativa (${Math.round(timeToExpire/60000)} min restante)`);
                        lastActivityMS = Date.now();
                    }
                } catch (pingError) {
                    console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ⚠️ Ping falhou, renovando sessão...`);
                    await loginMS();
                }
            }
        }
    } catch (error) {
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] ❌ Erro na manutenção: ${error.message}`);
    }
}, 2 * 60 * 1000); // A cada 2 minutos

// Login inicial
(async () => {
    try {
        await loginMS();
        console.log('[CARTORIO-MS] ✅ Login inicial realizado com sucesso');
    } catch (error) {
        console.log('[CARTORIO-MS] ⚠️ Login inicial falhou:', error.message);
    }
})();


// ============================================
// CONFIGURAÇÃO FOTO PR (SESP-PR) - SEM PROXY (FUNCIONOU)
// ============================================

const BASE_URL_PR = "https://apigateway-app.paas.pr.gov.br/sesp/sespintranet/api/v1";

const CREDENTIALS_PR = {
    usuario: "hugo.origa",
    senha: "Hugooriga80",
};

const BASE_HEADERS_PR = {
    "Accept": "application/json",
    "Accept-Charset": "UTF-8",
    "Connection": "Keep-Alive",
    "Consumerid": "SESP_INVESTIGACAO",
    "Content-Type": "application/json",
    "Cookie": "49366112b78aeb319b922db809c27b84=636be0609a9e5e2d6feaf170c3767108",
    "idHardware": "a9e99bc2-e1d8-4c66-83dc-f0595855f41a",
    "latitude": "0",
    "longitude": "0",
    "precisao": "0",
    "senha": "hYS&*f4!l0J",
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 7.1.2; SM-G988N Build/NRD90M)",
    "usuario": "SESP-MOBILE",
};

function formatarCpfParaPR(cpf) {
    const apenasDigitos = cpf.replace(/\D/g, '');
    if (apenasDigitos.length !== 11) {
        throw new Error(`CPF inválido: '${cpf}'. Deve conter 11 dígitos.`);
    }
    return `${apenasDigitos.substring(0,3)}.${apenasDigitos.substring(3,6)}.${apenasDigitos.substring(6,9)}-${apenasDigitos.substring(9)}`;
}

async function obterTokenPR() {
    let token = cache.get('sesp_token');
    
    if (token) {
        return token;
    }

    try {
        console.log('[FOTO-PR] 🔄 Obtendo token...');
        
        const response = await axios.post(`${BASE_URL_PR}/login`, CREDENTIALS_PR, {
            headers: BASE_HEADERS_PR,
            timeout: 30000
        });

        if (response.status === 200 || response.status === 201) {
            const dados = response.data;
            if (dados.retorno) {
                token = dados.token;
                cache.set('sesp_token', token);
                console.log('[FOTO-PR] ✅ Token obtido com sucesso');
                return token;
            }
        }
        
        throw new Error('Não foi possível obter token do SESP-PR');

    } catch (error) {
        console.error('[FOTO-PR] ❌ Erro no login:', error.message);
        throw new Error(`Falha no login SESP-PR: ${error.message}`);
    }
}

async function consultarPessoaPorCPF_PR(cpfFormatado, token) {
    try {
        const response = await axios.post(`${BASE_URL_PR}/Pessoa/Listar`, {
            numRg: cpfFormatado,
            nome: null,
            numPagina: "",
            qtdeRegistrosPorPagina: "",
        }, {
            headers: { ...BASE_HEADERS_PR, token: token },
            timeout: 30000
        });

        return response.data;
    } catch (error) {
        console.error('[FOTO-PR] ❌ Erro consultar pessoa:', error.message);
        if (error.response) {
            console.error('[FOTO-PR] Status:', error.response.status);
            console.error('[FOTO-PR] Data:', error.response.data);
        }
        throw new Error(`Erro ao consultar pessoa: ${error.message}`);
    }
}

async function consultarFotoPR(codPessoa, token) {
    try {
        const response = await axios.post(`${BASE_URL_PR}/Pessoa/ObterFoto`, {
            codPessoa: codPessoa,
            altura: "750",
            redimensionar: "true",
        }, {
            headers: { ...BASE_HEADERS_PR, token: token },
            timeout: 30000
        });

        const dados = response.data;
        return (dados.codRetorno === 1) ? dados.retorno : null;

    } catch (error) {
        console.error('[FOTO-PR] ❌ Erro consultar foto:', error.message);
        return null;
    }
}

async function consultarBoletinsPR(rg, token) {
    try {
        const response = await axios.post(`${BASE_URL_PR}/BoletimOcorrencia/ListarResteasy`, {
            codBoletim: null,
            anoBoletim: null,
            nomeEnvolvido: null,
            rg: rg,
            nomeMae: null,
            nomePai: null,
            fatoInicial: null,
            fatoFinal: null,
        }, {
            headers: { ...BASE_HEADERS_PR, token: token },
            timeout: 30000
        });

        return response.data;
    } catch (error) {
        console.error('[FOTO-PR] ❌ Erro consultar boletins:', error.message);
        throw new Error(`Erro ao consultar boletins: ${error.message}`);
    }
}

async function consultarFotoPRPrincipal(cpf) {
    try {
        const token = await obterTokenPR();
        let cpfFormatado;
        
        try {
            cpfFormatado = formatarCpfParaPR(cpf);
        } catch (error) {
            throw new Error(error.message);
        }

        console.log(`[FOTO-PR] 🔍 Consultando CPF: ${cpfFormatado}`);

        const dadosPessoa = await consultarPessoaPorCPF_PR(cpfFormatado, token);

        if (dadosPessoa.codRetorno !== 1 || !dadosPessoa.retorno || dadosPessoa.retorno.length === 0) {
            console.log('[FOTO-PR] ⚠️ Nenhuma pessoa encontrada');
            return null;
        }

        const pessoa = dadosPessoa.retorno[0];
        const rg = pessoa.numRg || "";
        const codPessoa = pessoa.codPessoa || "";

        console.log(`[FOTO-PR] 👤 Pessoa encontrada: ${pessoa.nome || 'N/A'}`);

        const boletins = await consultarBoletinsPR(rg, token);
        const foto = await consultarFotoPR(codPessoa, token);

        return {
            consulta_por: "CPF",
            parametro: cpfFormatado,
            foto_base64: foto,
            dados: pessoa,
            boletins: {
                total: boletins.tamanhoListaRetorno || 0,
                registros: boletins.retorno || [],
            }
        };
        
    } catch (error) {
        console.error('[FOTO-PR] ❌ Erro:', error.message);
        throw error;
    }
}

// ============================================
// FUNÇÕES GENÉRICAS
// ============================================

async function consultarAPI(nomeFonte, config, valor, paramNameOverride = null) {
    try {
        const params = { ...config.params };
        let paramName = 'text';
        if (nomeFonte === 'SUS') {
            paramName = 'cpf';
        } else if (paramNameOverride) {
            paramName = paramNameOverride;
        }
        params[paramName] = valor;
        
        console.log(`[API] ${nomeFonte} - Parâmetro: ${paramName}=${valor}`);
        
        const response = await axios({
            method: 'get',
            url: config.url,
            params: params,
            timeout: 10000
        });
        
        return {
            fonte: nomeFonte,
            status: 'sucesso',
            dados: response.data,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error(`[API] ${nomeFonte} - Erro:`, error.message);
        return {
            fonte: nomeFonte,
            status: 'erro',
            erro: error.response?.data || error.message,
            timestamp: new Date().toISOString()
        };
    }
}

async function consultarMultiplasAPIs(apis, valor) {
    const promises = Object.entries(apis).map(([nome, config]) => 
        consultarAPI(nome, config, valor)
    );
    
    const resultados = await Promise.all(promises);
    
    const resultadosOrganizados = {};
    resultados.forEach(resultado => {
        resultadosOrganizados[resultado.fonte] = {
            status: resultado.status,
            ...(resultado.status === 'sucesso' 
                ? { dados: resultado.dados } 
                : { erro: resultado.erro }),
            timestamp: resultado.timestamp
        };
    });
    
    return resultadosOrganizados;
}

function validarCPF(cpf) {
    const cpfLimpo = cpf.replace(/\D/g, '');
    return cpfLimpo.length === 11;
}

function validarNome(nome) {
    return nome && nome.trim().length >= 3;
}

function validarPlaca(placa) {
    const placaLimpa = placa.trim().toUpperCase();
    const placaAntiga = /^[A-Z]{3}[ -]?[0-9]{4}$/;
    const placaMercosul = /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/;
    return placaAntiga.test(placaLimpa) || placaMercosul.test(placaLimpa);
}

function validarRG(rg) {
    const rgLimpo = rg.replace(/\D/g, '');
    return rgLimpo.length >= 5;
}

function validarApiKey(req, res, next) {
    const { apikey } = req.query;
    
    if (!apikey || apikey !== 'neymarconvocado') {
        return res.status(401).json({
            erro: 'Não autorizado',
            mensagem: 'API Key inválida ou não fornecida.'
        });
    }
    
    next();
}

// ============================================
// FUNÇÕES FOTO MG (DETRAN-MG) - SEM PROXY
// ============================================

async function fetchImage(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://empresas.detran.mg.gov.br/'
        }
    });
    return loadImage(Buffer.from(response.data));
}

// ============================================
// BIGDATACORP - CONSULTA COMPLETA (SEM PROXY)
// ============================================

const BIGDATA_SESSION_ID = "79c1dad388844bd297abb97b78e7aeab";
const BIGDATA_PLATAFORMA_URL = "https://plataforma.bigdatacorp.com.br/pessoas";
const BIGDATA_MAX_PAGES = 10;

const bigDataState = {
    sessionId: BIGDATA_SESSION_ID,
    isActive: false,
    lastPing: null,
    pingCount: 0,
    lastError: null
};

async function pingBigDataSession() {
    try {
        const payload = {
            sessionId: BIGDATA_SESSION_ID,
            Datasets: "basic_data",
            q: "doc{09460801439},returnupdates{false},dateformat{dd/MM/yyyy}"
        };

        const response = await axios.post(BIGDATA_PLATAFORMA_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Origin': 'https://center.bigdatacorp.com.br',
                'Referer': 'https://center.bigdatacorp.com.br/'
            },
            timeout: 10000
        });

        if (response.status === 200) {
            bigDataState.isActive = true;
            bigDataState.lastPing = new Date();
            bigDataState.pingCount++;
            bigDataState.lastError = null;
            console.log(`[BigData] ✅ Ping #${bigDataState.pingCount} - Sessão ativa`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('[BigData] ❌ Erro no ping:', error.message);
        bigDataState.isActive = false;
        bigDataState.lastError = error.message;
        return false;
    }
}

async function verificarBigDataSession() {
    try {
        const payload = {
            sessionId: BIGDATA_SESSION_ID,
            Datasets: "basic_data",
            q: "doc{09460801439},returnupdates{false},dateformat{dd/MM/yyyy}"
        };

        const response = await axios.post(BIGDATA_PLATAFORMA_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Origin': 'https://center.bigdatacorp.com.br',
                'Referer': 'https://center.bigdatacorp.com.br/'
            },
            timeout: 10000
        });

        if (response.status === 200) {
            const data = response.data;
            
            if (data.Result && data.Result.length > 0) {
                bigDataState.isActive = true;
                bigDataState.lastError = null;
                return true;
            }
            
            if (data.Status) {
                for (const statusList of Object.values(data.Status)) {
                    if (Array.isArray(statusList) && statusList.length > 0) {
                        if (statusList[0].Code === 401 || 
                            String(statusList[0].Message || '').toLowerCase().includes('session')) {
                            bigDataState.isActive = false;
                            bigDataState.lastError = statusList[0].Message || 'Sessão inválida';
                            return false;
                        }
                    }
                }
            }
            
            bigDataState.isActive = true;
            bigDataState.lastError = null;
            return true;
        }
        return false;
    } catch (error) {
        console.error('[BigData] ❌ Erro ao verificar sessão:', error.message);
        bigDataState.isActive = false;
        bigDataState.lastError = error.message;
        return false;
    }
}

async function garantirSessaoBigData() {
    if (!bigDataState.isActive) {
        console.log('[BigData] 🔄 Sessão inativa, verificando...');
        const valid = await verificarBigDataSession();
        if (!valid) {
            console.log('[BigData] 🔄 Tentando ping para reativar...');
            await pingBigDataSession();
        }
    }
    return bigDataState.isActive;
}

async function buscarDadosPaginadosBigData(cpf, dataset, key, maxPages = BIGDATA_MAX_PAGES) {
    const todosDados = [];

    for (let pagina = 0; pagina < maxPages; pagina++) {
        try {
            const ds = pagina === 0 ? dataset : `${dataset}.page(${pagina})`;

            const payload = {
                sessionId: BIGDATA_SESSION_ID,
                Datasets: ds,
                q: `doc{${cpf}},returnupdates{false},dateformat{dd/MM/yyyy}`
            };

            const response = await axios.post(BIGDATA_PLATAFORMA_URL, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Origin': 'https://center.bigdatacorp.com.br',
                    'Referer': 'https://center.bigdatacorp.com.br/'
                },
                timeout: 15000
            });

            if (response.status === 200) {
                const data = response.data;
                if (data.Result && data.Result.length > 0 && data.Result[0][key]) {
                    const dados = data.Result[0][key];
                    if (dados) {
                        if (Array.isArray(dados)) {
                            if (dados.length === 0) break;
                            todosDados.push(...dados);
                        } else {
                            todosDados.push(dados);
                            break;
                        }
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            } else {
                break;
            }
        } catch (error) {
            console.error(`[BigData] ❌ Erro na página ${pagina}:`, error.message);
            break;
        }
    }

    return todosDados;
}

async function consultarBigDataCompleto(cpf) {
    const cpfLimpo = cpf.replace(/\D/g, '');

    await garantirSessaoBigData();
    
    if (!bigDataState.isActive) {
        console.error('[BigData] ❌ Sessão indisponível');
        return null;
    }

    console.log(`[BigData] 🔍 Consultando CPF: ${cpfLimpo}`);

    const datasets = {
        'basic_data': 'BasicData',
        'addresses_extended': 'ExtendedAddresses',
        'related_people': 'RelatedPeople',
        'phones_extended': 'ExtendedPhones',
        'emails_extended': 'ExtendedEmails',
        'processes': 'Processes',
        'occupation_data': 'ProfessionData',
        'media_profile_and_exposure': 'MediaProfileAndExposure',
        'company_links': 'CompanyLinks',
        'economic_activities': 'EconomicActivities',
        'vehicle_ownership': 'VehicleOwnership',
        'real_estate': 'RealEstate',
        'social_media': 'SocialMedia',
        'education': 'Education',
        'professional_affiliations': 'ProfessionalAffiliations',
        'public_office': 'PublicOffice',
        'election_data': 'ElectionData',
        'court_judgments': 'CourtJudgments',
        'bankruptcy': 'Bankruptcy',
        'business_associations': 'BusinessAssociations',
        'family_connections': 'FamilyConnections',
        'financial_products': 'FinancialProducts',
        'credit_score': 'CreditScore',
        'risk_indicators': 'RiskIndicators',
        'company_roles': 'CompanyRoles',
        'company_addresses': 'CompanyAddresses',
        'company_phones': 'CompanyPhones',
        'company_emails': 'CompanyEmails',
        'company_websites': 'CompanyWebsites',
        'company_financials': 'CompanyFinancials',
        'labor_lawsuits': 'LaborLawsuits',
        'criminal_records': 'CriminalRecords',
        'civil_lawsuits': 'CivilLawsuits',
        'tax_lawsuits': 'TaxLawsuits',
        'property_tax': 'PropertyTax',
        'vehicle_tax': 'VehicleTax',
        'land_records': 'LandRecords',
        'socios': 'Socios',
        'dependentes': 'Dependentes',
        'testemunhas': 'Testemunhas',
        'current_address': 'CurrentAddress',
        'previous_addresses': 'PreviousAddresses',
        'address_history': 'AddressHistory',
        'all_phones': 'AllPhones',
        'phone_history': 'PhoneHistory',
        'all_emails': 'AllEmails',
        'email_history': 'EmailHistory'
    };

    const resultados = {};
    let sessionExpirou = false;

    for (const [ds, key] of Object.entries(datasets)) {
        try {
            const datasetName = ['phones_extended', 'processes', 'media_profile_and_exposure'].includes(ds) 
                ? `${ds}.limit(100)` 
                : ds;

            const payload = {
                sessionId: BIGDATA_SESSION_ID,
                Datasets: datasetName,
                q: `doc{${cpfLimpo}},returnupdates{false},dateformat{dd/MM/yyyy}`
            };

            console.log(`[BigData] 📤 Consultando ${ds}...`);

            const response = await axios.post(BIGDATA_PLATAFORMA_URL, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Origin': 'https://center.bigdatacorp.com.br',
                    'Referer': 'https://center.bigdatacorp.com.br/'
                },
                timeout: 15000
            });

            if (response.status === 200) {
                const data = response.data;

                if (data.Status) {
                    for (const statusList of Object.values(data.Status)) {
                        if (Array.isArray(statusList) && statusList.length > 0) {
                            if (statusList[0].Code === 401 || 
                                String(statusList[0].Message || '').toLowerCase().includes('session')) {
                                sessionExpirou = true;
                                console.warn('[BigData] ⚠️ Sessão expirou!');
                                break;
                            }
                        }
                    }
                }

                if (sessionExpirou) break;

                if (data.Result && data.Result.length > 0 && data.Result[0][key]) {
                    resultados[key] = data.Result[0][key];
                    console.log(`[BigData] ✅ ${ds} carregado`);
                } else {
                    console.log(`[BigData] ⚠️ ${ds} vazio`);
                }
            }
        } catch (error) {
            console.error(`[BigData] ❌ Erro em ${ds}:`, error.message);
        }
    }

    if (sessionExpirou) {
        console.log('[BigData] 🔄 Tentando reconectar...');
        const reconectado = await verificarBigDataSession();
        if (reconectado) {
            return consultarBigDataCompleto(cpf);
        }
        return null;
    }

    const datasetsPaginados = [
        { dataset: 'related_people_phones', key: 'RelatedPeoplePhones' },
        { dataset: 'processes', key: 'Processes' },
        { dataset: 'addresses_extended', key: 'ExtendedAddresses' }
    ];

    for (const { dataset, key } of datasetsPaginados) {
        try {
            console.log(`[BigData] 📤 Buscando ${dataset} paginado...`);
            const dados = await buscarDadosPaginadosBigData(cpfLimpo, dataset, key);
            if (dados && dados.length > 0) {
                resultados[key] = dados;
                console.log(`[BigData] ✅ ${dataset} paginado carregado: ${dados.length} itens`);
            }
        } catch (error) {
            console.error(`[BigData] ❌ Erro em ${dataset} paginado:`, error.message);
        }
    }

    if (!resultados.BasicData) {
        console.log('[BigData] ⚠️ CPF não encontrado');
        return null;
    }

    return {
        session_id: BIGDATA_SESSION_ID,
        session_active: bigDataState.isActive,
        dados: resultados,
        timestamp: new Date().toISOString()
    };
}

function extrairDadosFormatadosBigData(dadosCompletos) {
    const basic = dadosCompletos.dados.BasicData || {};
    const addresses = dadosCompletos.dados.ExtendedAddresses || {};
    const related = dadosCompletos.dados.RelatedPeople || {};
    const phones = dadosCompletos.dados.ExtendedPhones || {};
    const emailsData = dadosCompletos.dados.ExtendedEmails || {};
    const processosData = dadosCompletos.dados.Processes || {};
    const occupation = dadosCompletos.dados.ProfessionData || {};
    const media = dadosCompletos.dados.MediaProfileAndExposure || {};
    const relatedPhones = dadosCompletos.dados.RelatedPeoplePhones || [];

    const enderecos = (addresses.Addresses || []).slice(0, 3).map(a => ({
        rua: a.AddressMain || '',
        numero: a.Number || '',
        complemento: a.Complement || null,
        bairro: a.Neighborhood || '',
        cep: a.ZipCode || '',
        cidade: a.City || '',
        estado: a.State || ''
    }));

    const parentes = (related.PersonalRelationships || []).slice(0, 10).map(r => ({
        nome: r.RelatedEntityName || '',
        cpf: r.RelatedEntityTaxIdNumber || '',
        parentesco: r.RelationshipType || ''
    }));

    const telefones = [];
    if (phones.Phones) {
        telefones.push(...phones.Phones.slice(0, 5).map(p => ({
            numero: p.Number || '',
            ddd: p.AreaCode || '',
            tipo: p.Type || '',
            parentesco: null
        })));
    }
    if (relatedPhones.length > 0) {
        telefones.push(...relatedPhones.slice(0, 20).map(p => ({
            numero: p.Number || '',
            ddd: p.AreaCode || '',
            tipo: p.Type || '',
            parentesco: p.RelationshipType || ''
        })));
    }

    const emails = (emailsData.Emails || []).slice(0, 5).map(e => ({
        email: e.Email || '',
        tipo: e.Type || ''
    }));

    const processos = (processosData.Lawsuits || []).slice(0, 5).map(p => ({
        numero: p.Number || '',
        tipo: p.Type || '',
        data: p.Date || null,
        status: p.Status || null
    }));

    return {
        nome: basic.Name || '',
        cpf: basic.TaxIdNumber || '',
        nascimento: (basic.BirthDate || '').replace('T00:00:00Z', ''),
        idade: basic.Age || null,
        mae: basic.MotherName || null,
        pai: basic.FatherName || null,
        status_cpf: basic.TaxIdStatus || null,
        enderecos,
        parentes,
        telefones: telefones.slice(0, 20),
        emails,
        processos,
        profissao: occupation.CurrentProfession || 
                   (occupation.Professions && occupation.Professions[0] ? occupation.Professions[0].Title : null),
        renda: occupation.TotalIncomeRange || null,
        empregado: occupation.IsEmployed || null,
        exposicao: media.MediaExposureLevel || null,
        dados_brutos: dadosCompletos.dados
    };
}

// ============================================
// INICIALIZAÇÃO DO PING AUTOMÁTICO
// ============================================

setInterval(async () => {
    await pingBigDataSession();
}, 60000);

(async () => {
    console.log('[BigData] 🔍 Verificando sessão inicial...');
    const valid = await verificarBigDataSession();
    if (valid) {
        console.log('[BigData] ✅ Sessão válida!');
        bigDataState.isActive = true;
    } else {
        console.log('[BigData] ⚠️ Sessão inválida, tentando ping...');
        await pingBigDataSession();
    }
})();

// ============================================
// ROTAS BigDataCorp
// ============================================

app.get('/bigdata', validarApiKey, async (req, res) => {
    try {
        let { cpf } = req.query;

        if (!cpf) {
            return res.status(400).json({
                erro: 'CPF não fornecido',
                mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
            });
        }

        const cpfLimpo = cpf.replace(/\D/g, '');

        if (!validarCPF(cpfLimpo)) {
            return res.status(400).json({
                erro: 'CPF inválido',
                mensagem: 'O CPF deve conter 11 dígitos numéricos'
            });
        }

        console.log(`[${new Date().toISOString()}] Consulta BigData para CPF: ${cpfLimpo}`);

        const dadosCompletos = await consultarBigDataCompleto(cpfLimpo);

        if (!dadosCompletos) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'CPF não encontrado na BigDataCorp',
                cpf_consultado: cpfLimpo
            });
        }

        const dadosFormatados = extrairDadosFormatadosBigData(dadosCompletos);

        res.json({
            sucesso: true,
            fonte: 'BigDataCorp',
            session_id: BIGDATA_SESSION_ID,
            session_active: bigDataState.isActive,
            cpf_consultado: cpfLimpo,
            consulta_realizada_em: new Date().toISOString(),
            dados: dadosFormatados,
            dados_brutos: dadosCompletos.dados,
            metadados: {
                ping_count: bigDataState.pingCount,
                last_ping: bigDataState.lastPing ? bigDataState.lastPing.toISOString() : null
            }
        });

    } catch (error) {
        console.error('[BigData] ❌ Erro:', error.message);
        res.status(500).json({
            sucesso: false,
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/bigdata/raw', validarApiKey, async (req, res) => {
    try {
        let { cpf } = req.query;

        if (!cpf) {
            return res.status(400).json({
                erro: 'CPF não fornecido',
                mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
            });
        }

        const cpfLimpo = cpf.replace(/\D/g, '');

        if (!validarCPF(cpfLimpo)) {
            return res.status(400).json({
                erro: 'CPF inválido',
                mensagem: 'O CPF deve conter 11 dígitos numéricos'
            });
        }

        console.log(`[${new Date().toISOString()}] BigData RAW para CPF: ${cpfLimpo}`);

        await garantirSessaoBigData();

        const payload = {
            sessionId: BIGDATA_SESSION_ID,
            Datasets: 'basic_data,addresses_extended,related_people,phones_extended,emails_extended,processes,occupation_data,media_profile_and_exposure',
            q: `doc{${cpfLimpo}},returnupdates{false},dateformat{dd/MM/yyyy}`
        };

        const response = await axios.post(BIGDATA_PLATAFORMA_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Origin': 'https://center.bigdatacorp.com.br',
                'Referer': 'https://center.bigdatacorp.com.br/'
            },
            timeout: 30000
        });

        if (response.status === 200) {
            const data = response.data;
            if (data.Result && data.Result.length > 0) {
                res.json({
                    sucesso: true,
                    fonte: 'BigDataCorp',
                    session_id: BIGDATA_SESSION_ID,
                    cpf_consultado: cpfLimpo,
                    dados_brutos: data,
                    timestamp: new Date().toISOString()
                });
            } else {
                res.status(404).json({
                    sucesso: false,
                    mensagem: 'CPF não encontrado'
                });
            }
        } else {
            res.status(response.status).json({
                sucesso: false,
                mensagem: `Erro HTTP: ${response.status}`
            });
        }
    } catch (error) {
        console.error('[BigData] ❌ Erro:', error.message);
        res.status(500).json({
            sucesso: false,
            erro: error.message
        });
    }
});

app.get('/bigdata/status', validarApiKey, async (req, res) => {
    try {
        const valid = await verificarBigDataSession();
        res.json({
            sucesso: true,
            session_id: BIGDATA_SESSION_ID,
            session_active: bigDataState.isActive,
            session_valid: valid,
            ping_count: bigDataState.pingCount,
            last_ping: bigDataState.lastPing ? bigDataState.lastPing.toISOString() : null,
            last_error: bigDataState.lastError,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            sucesso: false,
            erro: error.message
        });
    }
});

app.post('/bigdata/ping', validarApiKey, async (req, res) => {
    try {
        const result = await pingBigDataSession();
        res.json({
            sucesso: result,
            session_id: BIGDATA_SESSION_ID,
            session_active: bigDataState.isActive,
            ping_count: bigDataState.pingCount,
            last_ping: bigDataState.lastPing ? bigDataState.lastPing.toISOString() : null,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            sucesso: false,
            erro: error.message
        });
    }
});

// ============================================
// CONFIGURAÇÃO SSPDS-CE (Consulta Placa) - COM PROXY HTTP
// ============================================

const SSPDS_PROXY_CONFIG = {
    host: 'rp.scrapegw.com',
    port: 6060,
    username: 'ghcybjqddqcveo8-country-br',
    password: 'g9xw9d0p2rkd5oe'
};

const SSPDS_PROXY_URL = `http://${SSPDS_PROXY_CONFIG.username}:${SSPDS_PROXY_CONFIG.password}@${SSPDS_PROXY_CONFIG.host}:${SSPDS_PROXY_CONFIG.port}`;

const SSPDS_CREDENTIALS = {
    username: '01139158376',
    password: 'Samuka01'
};

const SSPDS_BASE_URL = 'https://consulta.sspds.ce.gov.br';

class SSPDSCEClient {
    constructor() {
        this.logged_in = false;
        this.cookies = null;
        this.client = null;
        this.proxyAgent = null;
        this.lastLoginTime = null;
        this.sessionTimeout = 5 * 60 * 1000;
    }

    log(msg) {
        console.log(`[${new Date().toISOString()}] [SSPDS-CE] ${msg}`);
    }

    criarProxy() {
        try {
            this.proxyAgent = new HttpsProxyAgent(SSPDS_PROXY_URL);
            this.log('🔄 Proxy HTTP criado com sucesso');
            this.log(`🌐 Proxy: ${SSPDS_PROXY_CONFIG.host}:${SSPDS_PROXY_CONFIG.port}`);
            return true;
        } catch (error) {
            this.log(`❌ Erro ao criar proxy: ${error.message}`);
            return false;
        }
    }

    async fazerLogin(tentativa = 1) {
        const maxTentativas = 3;
        
        try {
            this.criarProxy();
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            this.log(`🔐 Login (tentativa ${tentativa}/${maxTentativas})...`);
            
            const params = new URLSearchParams();
            params.append('username', SSPDS_CREDENTIALS.username);
            params.append('password', SSPDS_CREDENTIALS.password);
            params.append('submit', ' OK ');

            const response = await axios.post(`${SSPDS_BASE_URL}/consulta/logon.do`, params.toString(), {
                httpAgent: this.proxyAgent,
                httpsAgent: this.proxyAgent,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': `${SSPDS_BASE_URL}/consulta/index.do`,
                    'Origin': SSPDS_BASE_URL
                },
                timeout: 60000,
                proxy: false
            });

            const cookies = response.headers['set-cookie'];
            let cookieString = '';
            if (cookies) {
                cookieString = cookies.map(c => c.split(';')[0]).join('; ');
                this.cookies = cookieString;
            }

            if (response.data && !response.data.includes('Login inválido') && !response.data.includes('senha inválida')) {
                this.client = axios.create({
                    baseURL: SSPDS_BASE_URL,
                    httpAgent: this.proxyAgent,
                    httpsAgent: this.proxyAgent,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Cookie': cookieString,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: 60000
                });
                
                this.logged_in = true;
                this.lastLoginTime = Date.now();
                this.log(`✅ Login OK`);
                return true;
            }
            
            this.log('❌ Login falhou - resposta inválida');
            return false;
            
        } catch (error) {
            this.log(`❌ Erro login (tentativa ${tentativa}): ${error.message}`);
            if (error.response) {
                this.log(`Status: ${error.response.status}`);
            }
            
            if (tentativa < maxTentativas) {
                this.log('🔄 Aguardando 3 segundos antes de tentar novamente...');
                await new Promise(resolve => setTimeout(resolve, 3000));
                return this.fazerLogin(tentativa + 1);
            }
            
            return false;
        }
    }

    async login() {
        return await this.fazerLogin();
    }

    async ensureLogin() {
        if (this.logged_in && this.lastLoginTime) {
            const elapsed = Date.now() - this.lastLoginTime;
            if (elapsed > this.sessionTimeout) {
                this.log('⏰ Sessão expirada, fazendo login novamente...');
                this.logged_in = false;
            }
        }

        if (!this.logged_in || !this.client) {
            this.log('⚠️ Não está logado, realizando login...');
            const result = await this.fazerLogin();
            if (!result) {
                this.log('❌ Falha crítica no login');
                return false;
            }
            return true;
        }
        return true;
    }

    async consultarPlaca(placa, tentativa = 1) {
        try {
            const placaLimpa = placa.replace(/[-\s]/g, '').toUpperCase();
            
            if (tentativa > 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            this.log(`🔍 Consultando placa: ${placaLimpa}`);

            if (!await this.ensureLogin()) {
                return { success: false, message: 'Falha no login' };
            }
            
            const params = new URLSearchParams();
            params.append('tipo', '4');
            params.append('detranTipoBase', '2');
            params.append('placaChassi', placaLimpa);
            
            const response = await this.client.post('/consulta/consultaNome.do', params.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': `${SSPDS_BASE_URL}/consulta/logon.do`,
                    'Origin': SSPDS_BASE_URL
                }
            });
            
            if (response.data && response.data.includes('Placa:')) {
                this.log('✅ Consulta realizada com sucesso');
                this.lastLoginTime = Date.now();
                return { success: true, html: response.data };
            } else {
                if (response.data && (response.data.includes('logon.do') || response.data.includes('username'))) {
                    this.log('🔄 Redirecionado para login, sessão expirada');
                    this.logged_in = false;
                    if (tentativa < 3) {
                        this.log('🔄 Tentando login novamente...');
                        if (await this.fazerLogin()) {
                            return this.consultarPlaca(placa, tentativa + 1);
                        }
                    }
                    return { success: false, message: 'Sessão expirada - faça login novamente' };
                }
                
                if (response.data && response.data.includes('Nenhum resultado encontrado')) {
                    this.log('❌ Placa não encontrada');
                    return { success: false, message: 'Placa não encontrada' };
                }
                
                throw new Error('Resposta inválida do servidor');
            }
            
        } catch (error) {
            this.log(`❌ Erro consulta (tentativa ${tentativa}): ${error.message}`);
            
            if ((error.message.includes('Socket closed') || error.message.includes('ECONNRESET')) && tentativa < 3) {
                this.log('🔄 Conexão perdida, reconectando...');
                this.logged_in = false;
                if (await this.fazerLogin()) {
                    return this.consultarPlaca(placa, tentativa + 1);
                }
            }
            
            return { success: false, message: error.message };
        }
    }

    extrairDadosVeiculo(html) {
        const dados = {};
        
        const extract = (label) => {
            let pattern = new RegExp(`${label}:\\s*<b>([^<]+)<\\/b>`, 'i');
            let match = html.match(pattern);
            if (match && match[1] && match[1].trim() !== '') {
                return match[1].trim();
            }
            
            const labelNormalized = label
                .replace(/ã/g, '�')
                .replace(/ç/g, '�')
                .replace(/í/g, '�')
                .replace(/á/g, '�')
                .replace(/é/g, '�')
                .replace(/õ/g, '�')
                .replace(/ô/g, '�')
                .replace(/ê/g, '�')
                .replace(/ú/g, '�')
                .replace(/ó/g, '�');
            
            pattern = new RegExp(`${labelNormalized}:\\s*<b>([^<]+)<\\/b>`, 'i');
            match = html.match(pattern);
            if (match && match[1] && match[1].trim() !== '') {
                return match[1].trim();
            }
            
            pattern = new RegExp(`${label}:\\s*([^\\n<]+)`, 'i');
            match = html.match(pattern);
            if (match && match[1] && match[1].trim() !== '') {
                return match[1].trim();
            }
            
            const flexPattern = new RegExp(`${label}[^:]*:\\s*([^\\n<]+)`, 'i');
            match = html.match(flexPattern);
            if (match && match[1] && match[1].trim() !== '') {
                return match[1].trim();
            }
            
            return null;
        };
        
        dados.chassi = extract('Número Chassi');
        dados.placa = extract('Placa');
        dados.renavam = extract('RENAVAM');
        dados.situacao_veiculo = extract('Situação Veículo');
        dados.potencia_veiculo = extract('Potência Veículo');
        dados.cilindradas = extract('Cilindradas');
        dados.numero_motor = extract('Número Motor');
        dados.procedencia_veiculo = extract('Procedência do  Veículo');
        dados.capacidade_passageiros = extract('Capacidade de Passageiros');
        dados.restricao_1 = extract('Restrição 1');
        dados.restricao_2 = extract('Restrição 2');
        dados.restricao_3 = extract('Restrição 3');
        dados.restricao_4 = extract('Restrição 4');
        dados.marca_modelo = extract('Marca/Modelo');
        dados.cor = extract('Cor');
        dados.ano_fabricacao = extract('Ano de Fabricação');
        dados.ano_modelo = extract('Ano do Modelo');
        dados.numero_eixos = extract('Número Eixos');
        dados.tipo_veiculo = extract('Tipo Veículo');
        dados.tipo_carroceria = extract('Tipo Carroceria');
        dados.especie_veiculo = extract('Espécie Veículo');
        dados.uf = extract('Estado');
        dados.municipio = extract('Município');
        
        let cpfMatch = html.match(/CPF Propriet[áa]rio:\s*<b>([^<]+)<\/b>/i);
        if (!cpfMatch) {
            cpfMatch = html.match(/CPF Propriet�rio:\s*<b>([^<]+)<\/b>/i);
        }
        if (!cpfMatch) {
            cpfMatch = html.match(/CPF[^:]*:\s*([0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2})/i);
        }
        if (!cpfMatch) {
            cpfMatch = html.match(/CPF[^:]*:\s*([0-9]{11})/i);
        }
        if (!cpfMatch) {
            cpfMatch = html.match(/CPF[^0-9]*([0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2})/i);
        }
        if (!cpfMatch) {
            const tableMatch = html.match(/Dados do Propriet[áa]rio[\s\S]*?CPF[^:]*:\s*([0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2})/i);
            if (tableMatch) {
                cpfMatch = tableMatch;
            }
        }
        
        dados.cpf_proprietario = cpfMatch ? cpfMatch[1].replace(/\D/g, '') : null;
        
        let nomeMatch = html.match(/Nome Propriet[áa]rio:\s*<b>([^<]+)<\/b>/i);
        if (!nomeMatch) {
            nomeMatch = html.match(/Nome Propriet�rio:\s*<b>([^<]+)<\/b>/i);
        }
        if (!nomeMatch) {
            nomeMatch = html.match(/Nome[^:]*:\s*([A-Za-zÀ-ÿ\s]+)/i);
            if (nomeMatch && nomeMatch[1] && (nomeMatch[1].includes('CPF') || nomeMatch[1].includes('CNPJ'))) {
                nomeMatch = null;
            }
        }
        dados.nome_proprietario = nomeMatch ? nomeMatch[1].trim() : null;
        
        let cnpjMatch = html.match(/CNPJ Propriet[áa]rio:\s*<b>([^<]+)<\/b>/i);
        if (!cnpjMatch) {
            cnpjMatch = html.match(/CNPJ[^:]*:\s*([0-9]{2}\.?[0-9]{3}\.?[0-9]{3}\/?[0-9]{4}-?[0-9]{2})/i);
        }
        dados.cnpj_proprietario = cnpjMatch ? cnpjMatch[1].trim() : null;
        
        let s25Match = html.match(/Situaç[ãa]o S25:\s*<b>([^<]+)<\/b>/i);
        if (!s25Match) {
            s25Match = html.match(/Situaç�o S25:\s*<b>([^<]+)<\/b>/i);
        }
        if (!s25Match) {
            s25Match = html.match(/Situaç[ãa]o S25[^:]*:\s*([^\n<]+)/i);
        }
        dados.situacao_s25 = s25Match ? s25Match[1].trim() : null;
        
        if (html.includes('Veiculo cadastrado e com ocorrencia de roubo/furto') || 
            html.includes('Veículo cadastrado e com ocorrência de roubo/furto')) {
            dados.roubo_furto = true;
            dados.status_roubo = 'VEÍCULO COM OCORRÊNCIA DE ROUBO/FURTO';
        } else {
            dados.roubo_furto = false;
            dados.status_roubo = 'SEM OCORRÊNCIA DE ROUBO/FURTO';
        }
        
        dados.fonte = 'SSPDS-CE (DETRAN-CE)';
        dados.data_consulta = new Date().toISOString();
        
        const preenchidos = Object.keys(dados).filter(k => dados[k] && dados[k] !== null && dados[k] !== '').length;
        this.log(`✅ Extraídos: ${preenchidos}/${Object.keys(dados).length} campos`);
        
        if (dados.cpf_proprietario) {
            this.log(`📌 CPF Proprietário encontrado: ${dados.cpf_proprietario}`);
        } else {
            this.log('⚠️ CPF Proprietário não encontrado');
        }
        
        return dados;
    }
}

const sspdsCEClient = new SSPDSCEClient();

// ============================================
// CONSULTCENTER - COM PROXY HTTP
// ============================================

const CONSULTCENTER_PROXY_URL = `http://${SSPDS_PROXY_CONFIG.username}:${SSPDS_PROXY_CONFIG.password}@${SSPDS_PROXY_CONFIG.host}:${SSPDS_PROXY_CONFIG.port}`;
const consultCenterProxyAgent = new HttpsProxyAgent(CONSULTCENTER_PROXY_URL);

const CONSULTCENTER_CREDENTIALS = [
    { username: "100624", password: "Ntv82654" }
];

const CONSULTCENTER_BASE_URL = "https://sistema.consultcenter.com.br";

class ConsultCenterClient {
    constructor() {
        this.base_url = CONSULTCENTER_BASE_URL;
        this.credentialIndex = 0;
        this.logged_in = false;
        this.cookies = null;
        this.csrf_token = null;
        this.currentCredentials = CONSULTCENTER_CREDENTIALS[0];
        this.session = axios.create({
            baseURL: this.base_url,
            httpAgent: consultCenterProxyAgent,
            httpsAgent: consultCenterProxyAgent,
            timeout: 60000,
            maxRedirects: 10,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });
        this._auto_login();
    }

    log(msg) {
        console.log(`[${new Date().toISOString()}] [ConsultCenter] ${msg}`);
    }

    async _auto_login() {
        return await this._tentarLogin(0);
    }

    async _tentarLogin(credentialIndex) {
        if (credentialIndex >= CONSULTCENTER_CREDENTIALS.length) {
            this.log('❌ Todas as credenciais falharam!');
            return false;
        }

        const creds = CONSULTCENTER_CREDENTIALS[credentialIndex];
        this.currentCredentials = creds;
        this.log(`🔑 Tentando login com usuário: ${creds.username}`);

        try {
            const loginPage = await this.session.get('/users/login');
            const html = loginPage.data;
            
            let token = null;
            
            const tokenMatch = html.match(/<input[^>]*name="data\[_Token\]\[key\]"[^>]*value="([^"]+)"[^>]*>/i);
            if (tokenMatch) {
                token = tokenMatch[1];
            }
            
            if (!token) {
                this.log(`❌ Token CSRF não encontrado para ${creds.username}`);
                return false;
            }
            
            this.csrf_token = token;
            this.log(`✅ Token CSRF obtido: ${token.substring(0,20)}...`);
            
            const loginData = new URLSearchParams();
            loginData.append('_method', 'POST');
            loginData.append('data[_Token][key]', token);
            loginData.append('data[UsuarioLogin][username]', creds.username);
            loginData.append('data[UsuarioLogin][password]', creds.password);
            
            const response = await this.session.post('/users/login', loginData.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': this.base_url,
                    'Referer': `${this.base_url}/users/login`
                },
                maxRedirects: 0,
                validateStatus: status => status === 302 || status === 200
            });
            
            this.log(`📡 Status login: ${response.status}`);
            
            if (response.headers['set-cookie']) {
                const cookies = response.headers['set-cookie'].map(c => c.split(';')[0]);
                this.cookies = cookies.join('; ');
                this.session.defaults.headers['Cookie'] = this.cookies;
                this.log(`🍪 Cookies recebidos: ${cookies.length}`);
            }
            
            if (response.status === 302) {
                const location = response.headers.location || '/portal/index';
                this.log(`🔄 Redirecionando para: ${location}`);
                
                const redirectResponse = await this.session.get(location, {
                    headers: {
                        'Cookie': this.cookies || ''
                    }
                });
                
                if (redirectResponse.headers['set-cookie']) {
                    const newCookies = redirectResponse.headers['set-cookie'].map(c => c.split(';')[0]);
                    this.cookies = newCookies.join('; ');
                    this.session.defaults.headers['Cookie'] = this.cookies;
                }
                
                if (redirectResponse.data && !redirectResponse.data.includes('login')) {
                    this.logged_in = true;
                    this.credentialIndex = credentialIndex;
                    this.log(`✅ Login realizado com sucesso! Usuário: ${creds.username}`);
                    return true;
                }
            }
            
            if (response.status === 200) {
                if (!response.data.includes('username') && !response.data.includes('password')) {
                    this.logged_in = true;
                    this.credentialIndex = credentialIndex;
                    this.log(`✅ Login realizado com sucesso! Usuário: ${creds.username}`);
                    return true;
                }
            }
            
            if (this.cookies && this.cookies.includes('CAKEPHP')) {
                this.logged_in = true;
                this.credentialIndex = credentialIndex;
                this.log(`✅ Login realizado com sucesso (cookie)! Usuário: ${creds.username}`);
                return true;
            }
            
            this.log(`❌ Falha no login para ${creds.username}`);
            return false;
            
        } catch (error) {
            this.log(`❌ Erro no login com ${creds.username}: ${error.message}`);
            return false;
        }
    }

    async forceRelogin() {
        this.log('🔄 Forçando relogin...');
        this.logged_in = false;
        this.cookies = null;
        this.csrf_token = null;
        this.session = axios.create({
            baseURL: this.base_url,
            httpAgent: consultCenterProxyAgent,
            httpsAgent: consultCenterProxyAgent,
            timeout: 60000,
            maxRedirects: 10,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });
        return await this._auto_login();
    }

    async _ensure_login() {
        if (!this.logged_in) {
            this.log('⚠️ Não está logado, tentando login...');
            const result = await this._tentarLogin(this.credentialIndex);
            if (!result) {
                this.log('❌ Falha no login');
                return false;
            }
            return true;
        }
        return true;
    }

    async _get_token_from_page(url) {
        try {
            this.log(`🔑 Buscando token da página: ${url}`);
            
            const response = await this.session.get(url, {
                headers: {
                    'Cookie': this.cookies || ''
                }
            });
            
            const html = response.data;
            
            let token = null;
            
            const match1 = html.match(/<input[^>]*name="data\[_Token\]\[key\]"[^>]*value="([^"]+)"[^>]*>/i);
            if (match1) {
                token = match1[1];
                this.log(`✅ Token encontrado (formato 1): ${token.substring(0,20)}...`);
                return token;
            }
            
            const match2 = html.match(/<input[^>]*name="_Token"[^>]*value="([^"]+)"[^>]*>/i);
            if (match2) {
                token = match2[1];
                this.log(`✅ Token encontrado (formato 2): ${token.substring(0,20)}...`);
                return token;
            }
            
            const match3 = html.match(/<meta[^>]*name="csrf-token"[^>]*content="([^"]+)"[^>]*>/i);
            if (match3) {
                token = match3[1];
                this.log(`✅ Token encontrado (formato 3): ${token.substring(0,20)}...`);
                return token;
            }
            
            this.log(`❌ Nenhum token encontrado na página`);
            return null;
            
        } catch (error) {
            this.log(`❌ Erro ao obter token: ${error.message}`);
            return null;
        }
    }

    async _extract_results(html) {
        const $ = cheerio.load(html);
        const results = [];
        
        $('table').each((i, table) => {
            const rows = $(table).find('tr');
            if (rows.length > 1) {
                const headers = [];
                $(rows[0]).find('th').each((j, th) => {
                    headers.push($(th).text().trim().toLowerCase());
                });
                
                for (let k = 1; k < rows.length; k++) {
                    const cols = $(rows[k]).find('td');
                    if (cols.length) {
                        const result = {};
                        for (let h = 0; h < headers.length && h < cols.length; h++) {
                            const header = headers[h];
                            const value = $(cols[h]).text().trim();
                            if (header.includes('nome')) result.nome = value;
                            else if (header.includes('documento') || header.includes('cpf')) result.documento = value;
                            else if (header.includes('situação') || header.includes('status')) result.situacao = value;
                            else if (header.includes('uf') || header.includes('estado')) result.uf = value;
                            else if (header.includes('telefone') || header.includes('tel')) result.telefone = value;
                            else if (header.includes('data')) result.data = value;
                        }
                        if (Object.keys(result).length) {
                            results.push(result);
                        }
                    }
                }
            }
        });
        
        if (results.length === 0) {
            $('div[class*="result"], div[class*="item"], div[class*="card"]').each((i, div) => {
                const text = $(div).text().trim();
                const lines = text.split('\n').map(l => l.trim()).filter(l => l && l.length > 2);
                
                if (lines.length >= 3) {
                    const result = {};
                    let hasData = false;
                    
                    for (const line of lines) {
                        if (line.includes(':')) {
                            const parts = line.split(':');
                            if (parts.length >= 2) {
                                const key = parts[0].trim().toLowerCase();
                                const value = parts.slice(1).join(':').trim();
                                
                                if (key.includes('nome') || key.includes('name')) {
                                    result.nome = value;
                                    hasData = true;
                                } else if (key.includes('cpf') || key.includes('documento')) {
                                    result.documento = value;
                                    hasData = true;
                                } else if (key.includes('situação') || key.includes('status')) {
                                    result.situacao = value;
                                    hasData = true;
                                } else if (key.includes('uf') || key.includes('estado')) {
                                    result.uf = value;
                                    hasData = true;
                                } else if (key.includes('telefone') || key.includes('tel')) {
                                    result.telefone = value;
                                    hasData = true;
                                }
                            }
                        }
                    }
                    
                    if (hasData) {
                        results.push(result);
                    }
                }
            });
        }
        
        return results;
    }

    async _extract_sancoes_data_complete(html) {
        const $ = cheerio.load(html);
        const result = {
            dados_cadastrais: {},
            resumo_sancoes: {},
            sancoes: []
        };
        
        const text = $('body').text();
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && l.length > 0);
        
        const cadastral_data = {};
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('CPF:')) {
                cadastral_data.cpf = line.replace('CPF:', '').trim();
                if (i > 0 && lines[i-1] && !lines[i-1].includes(':')) {
                    cadastral_data.nome = lines[i-1].trim();
                }
            } else if (line.includes('Nascimento:')) {
                cadastral_data.nascimento = line.replace('Nascimento:', '').trim();
            } else if (line.includes('Idade:')) {
                cadastral_data.idade = line.replace('Idade:', '').trim();
            } else if (line.includes('Sexo:')) {
                cadastral_data.sexo = line.replace('Sexo:', '').trim();
            } else if (line.includes('Signo:')) {
                cadastral_data.signo = line.replace('Signo:', '').trim();
            } else if (line.includes('Titulo de eleitor:')) {
                cadastral_data.titulo_eleitor = line.replace('Titulo de eleitor:', '').trim();
            } else if (line.includes('Estado de Origem:')) {
                cadastral_data.estado_origem = line.replace('Estado de Origem:', '').trim();
            }
        }
        
        if (Object.keys(cadastral_data).length) {
            result.dados_cadastrais = cadastral_data;
        }
        
        const resumo = {};
        for (const line of lines) {
            if (line.includes('Sanções ativas:')) {
                resumo.sancoes_ativas = line.replace('Sanções ativas:', '').trim();
            } else if (line.includes('Qtde. sanções encontradas nos últimos 30 dias:')) {
                resumo.ultimos_30_dias = line.replace('Qtde. sanções encontradas nos últimos 30 dias:', '').trim();
            } else if (line.includes('Qtde. sanções encontradas nos últimos 90 dias:')) {
                resumo.ultimos_90_dias = line.replace('Qtde. sanções encontradas nos últimos 90 dias:', '').trim();
            } else if (line.includes('Qtde. sanções encontradas nos últimos 180 dias:')) {
                resumo.ultimos_180_dias = line.replace('Qtde. sanções encontradas nos últimos 180 dias:', '').trim();
            } else if (line.includes('Qtde. sanções encontradas nos últimos 365 dias:')) {
                resumo.ultimos_365_dias = line.replace('Qtde. sanções encontradas nos últimos 365 dias:', '').trim();
            } else if (line.includes('Pessoa exposta politicamente (PEP):')) {
                resumo.pep = line.replace('Pessoa exposta politicamente (PEP):', '').trim();
            } else if (line.includes('Qtde. PEP:')) {
                resumo.qtde_pep = line.replace('Qtde. PEP:', '').trim();
            } else if (line.includes('Qtde. PEP último ano:')) {
                resumo.pep_ultimo_ano = line.replace('Qtde. PEP último ano:', '').trim();
            } else if (line.includes('Qtde. PEP últimos 3 anos:')) {
                resumo.pep_ultimos_3_anos = line.replace('Qtde. PEP últimos 3 anos:', '').trim();
            } else if (line.includes('Qtde. PEP últimos 5 anos:')) {
                resumo.pep_ultimos_5_anos = line.replace('Qtde. PEP últimos 5 anos:', '').trim();
            }
        }
        
        if (Object.keys(resumo).length) {
            result.resumo_sancoes = resumo;
        }
        
        const htmlStr = html;
        const base64Images = htmlStr.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g) || [];
        const sancaoImages = base64Images.filter(img => img.length > 200);
        
        const sancaoRegex = /Sanção:([\s\S]*?)(?=Sanção:|$)/gi;
        let match;
        let sancaoBlocks = [];
        while ((match = sancaoRegex.exec(text)) !== null) {
            sancaoBlocks.push(match[1]);
        }
        
        let imageIndex = 0;
        for (const block of sancaoBlocks) {
            const sancao = this._extract_sancao_from_text(block);
            if (sancao && (sancao.fonte || sancao.tipo)) {
                if (imageIndex < sancaoImages.length) {
                    sancao.imagem = sancaoImages[imageIndex];
                    imageIndex++;
                }
                result.sancoes.push(sancao);
            }
        }
        
        if (result.sancoes.length === 0) {
            $('div, section, tr, td').each((i, element) => {
                const elementText = $(element).text();
                if (elementText.includes('Fonte:') && elementText.includes('Tipo:')) {
                    const sancao = this._extract_sancao_from_text(elementText);
                    if (sancao && (sancao.fonte || sancao.tipo)) {
                        if (imageIndex < sancaoImages.length) {
                            sancao.imagem = sancaoImages[imageIndex];
                            imageIndex++;
                        }
                        result.sancoes.push(sancao);
                    }
                }
            });
        }
        
        return result;
    }

    _extract_sancao_from_text(text) {
        const sancao = {};
        
        text = text.replace(/<[^>]+>/g, '');
        
        const patterns = {
            fonte: /Fonte:\s*([^\n]+)/i,
            tipo: /Tipo:\s*([^\n]+)/i,
            tipo_sancao_padronizado: /Tipo de Sanção Padronizado:\s*([^\n]+)/i,
            taxa_correspondencia: /Taxa de Correspondência em %:\s*([^\n]+)/i,
            pontuacao_exclusividade: /Pontuação de Exclusividade do Nome:\s*([^\n]+)/i,
            data_inicio: /Data de Início:\s*([^\n]+)/i,
            data_final: /Data Final:\s*([^\n]+)/i,
            atualmente_presente: /Atualmente Presente na Fonte:\s*([^\n]+)/i,
            recentemente_presente: /Recentemente Presente na Fonte:\s*([^\n]+)/i,
            ultima_atualizacao: /Última Data de Atualização:\s*([^\n]+)/i,
            nome_original: /Nome Original:\s*([^\n]+)/i,
            nome_sancao: /Nome da Sanção:\s*([^\n]+)/i,
            data_nascimento: /Data de Nascimento:\s*([^\n]+)/i,
            data_nascimento_padronizada: /Data de Nascimento padronizada:\s*([^\n]+)/i,
            nacionalidades: /Nacionalidades:\s*([^\n]+)/i,
            lingua_falada: /Língua Falada:\s*([^\n]+)/i,
            altura: /Altura:\s*([^\n]+)/i,
            peso: /Peso:\s*([^\n]+)/i,
            cor_olhos: /cor dos Olhos:\s*([^\n]+)/i,
            cor_cabelo: /cor de Cabelo:\s*([^\n]+)/i,
            cobrancas: /Cobranças:\s*([^\n]+)/i
        };
        
        for (const [key, pattern] of Object.entries(patterns)) {
            const match = text.match(pattern);
            if (match) {
                const value = match[1].trim();
                if (value && value !== 'NADA CONSTA' && value !== 'NÃO INFORMADO' && value !== 'N/A') {
                    sancao[key] = value;
                }
            }
        }
        
        const detalhesMatch = text.match(/Detalhes:\s*\n?([\s\S]*?)(?=\n\s*\n|$)/i);
        if (detalhesMatch) {
            const detalhes = detalhesMatch[1].trim();
            if (detalhes && detalhes.length > 3 && detalhes !== 'NADA CONSTA') {
                sancao.detalhes = detalhes;
            }
        }
        
        return sancao;
    }

    async _extract_process_data(html) {
        const $ = cheerio.load(html);
        const result = {
            dados_cadastrais: {},
            resumo_processos: {},
            processos: []
        };
        
        const text = $('body').text();
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && l.length > 0);
        
        const cadastral_data = {};
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('CPF:')) {
                cadastral_data.cpf = line.replace('CPF:', '').trim();
                if (i > 0 && lines[i-1] && !lines[i-1].includes(':')) {
                    cadastral_data.nome = lines[i-1].trim();
                }
            } else if (line.includes('Nascimento:')) {
                cadastral_data.nascimento = line.replace('Nascimento:', '').trim();
            } else if (line.includes('Idade:')) {
                cadastral_data.idade = line.replace('Idade:', '').trim();
            } else if (line.includes('Sexo:')) {
                cadastral_data.sexo = line.replace('Sexo:', '').trim();
            } else if (line.includes('Signo:')) {
                cadastral_data.signo = line.replace('Signo:', '').trim();
            }
        }
        
        if (Object.keys(cadastral_data).length) {
            result.dados_cadastrais = cadastral_data;
        }
        
        const resumo = {};
        for (const line of lines) {
            if (line.includes('Total de Processos:')) {
                const num = line.match(/\d+/);
                if (num) resumo.total_processos = parseInt(num[0]);
            } else if (line.includes('Total de Processos Autor:')) {
                const num = line.match(/\d+/);
                if (num) resumo.total_autor = parseInt(num[0]);
            } else if (line.includes('Total de Processos Réu:')) {
                const num = line.match(/\d+/);
                if (num) resumo.total_reu = parseInt(num[0]);
            } else if (line.includes('Processos dos Últimos 180 dias:')) {
                const num = line.match(/\d+/);
                if (num) resumo.ultimos_180_dias = parseInt(num[0]);
            }
        }
        
        if (Object.keys(resumo).length) {
            result.resumo_processos = resumo;
        }
        
        $('div[class*="process"], tr').each((i, el) => {
            const elText = $(el).text().trim();
            if (elText.includes('Número:') || elText.includes('Tipo:')) {
                const processo = {};
                const patterns = {
                    tipo: /Tipo:\s*([^\n]+)/i,
                    data_notificacao: /Data Notificação:\s*([^\n]+)/i,
                    numero: /Número:\s*([^\n]+)/i,
                    nivel_tribunal: /Nível Tribunal:\s*([^\n]+)/i,
                    status: /Status:\s*([^\n]+)/i,
                    vara_julgadora: /Vara Julgadora:\s*([^\n]+)/i,
                    tribunal: /Tribunal:\s*([^\n]+)/i,
                    tipo_tribunal: /Tipo Tribunal:\s*([^\n]+)/i,
                    cidade_tribunal: /Cidade Tribunal:\s*([^\n]+)/i,
                    estado_tribunal: /Estado Tribunal:\s*([^\n]+)/i,
                    assunto_principal: /Assunto Principal:\s*([^\n]+)/i
                };
                
                for (const [key, pattern] of Object.entries(patterns)) {
                    const match = elText.match(pattern);
                    if (match) {
                        const value = match[1].trim();
                        if (value && value !== 'NADA CONSTA' && value !== 'N/A') {
                            processo[key] = value;
                        }
                    }
                }
                
                const partesSection = elText.match(/Partes\s*\n?([\s\S]*?)(?=\n\s*\n|$)/i);
                if (partesSection) {
                    const partesText = partesSection[1].trim();
                    const partesLines = partesText.split('\n').map(l => l.trim()).filter(l => l);
                    const partes = [];
                    
                    for (const line of partesLines) {
                        if (line) {
                            const parts = line.split(/\s{2,}/);
                            if (parts.length >= 3) {
                                partes.push({
                                    nome: parts[0].trim(),
                                    posicao: parts[1].trim(),
                                    tipo: parts[2].trim()
                                });
                            } else {
                                const match = line.match(/(.+?)\s+(ATIVA|PASSIVA|NEUTRA)\s+(.+)/i);
                                if (match) {
                                    partes.push({
                                        nome: match[1].trim(),
                                        posicao: match[2].trim(),
                                        tipo: match[3].trim()
                                    });
                                }
                            }
                        }
                    }
                    
                    if (partes.length) {
                        processo.partes = partes;
                    }
                }
                
                if (Object.keys(processo).length > 0) {
                    result.processos.push(processo);
                }
            }
        });
        
        return result;
    }

    async _processar_resultado(response) {
        try {
            if (response.status === 302) {
                const location = response.headers.location || '/localizador_nacional/resultado';
                const resultPage = await this.session.get(location);
                
                if (resultPage.status === 200) {
                    const results = await this._extract_results(resultPage.data);
                    
                    if (results && results.length > 0) {
                        return {
                            success: true,
                            total: results.length,
                            results: results
                        };
                    } else {
                        return {
                            success: true,
                            total: 0,
                            results: [],
                            message: 'Nenhum resultado encontrado'
                        };
                    }
                } else {
                    return {
                        success: false,
                        message: `Erro ao carregar resultados: ${resultPage.status}`
                    };
                }
            } else if (response.status === 200) {
                const results = await this._extract_results(response.data);
                
                if (results && results.length > 0) {
                    return {
                        success: true,
                        total: results.length,
                        results: results
                    };
                }
                
                const $ = cheerio.load(response.data);
                const errorMsg = $('.alert, .error, .danger, .alert-danger, .alert-error').text().trim();
                if (errorMsg) {
                    return {
                        success: false,
                        message: `Erro: ${errorMsg}`
                    };
                }
                
                return {
                    success: false,
                    message: 'Nenhum resultado encontrado'
                };
            } else {
                return {
                    success: false,
                    message: `Falha na consulta. Status: ${response.status}`
                };
            }
        } catch (error) {
            this.log(`❌ Erro ao processar resultado: ${error.message}`);
            return {
                success: false,
                message: `Erro ao processar resultado: ${error.message}`
            };
        }
    }

    async consultarNome(nome, uf = '') {
        try {
            if (!await this._ensure_login()) {
                return { success: false, message: 'Falha no login' };
            }
            
            this.log(`🔍 Consultando por nome: ${nome}`);
            
            const consultUrl = '/localizador_nacional/consultar/4175';
            const token = await this._get_token_from_page(consultUrl);
            
            if (!token) {
                this.log('❌ Token não encontrado, tentando relogin...');
                await this.forceRelogin();
                const tokenRetry = await this._get_token_from_page(consultUrl);
                if (!tokenRetry) {
                    return { success: false, message: 'Token CSRF não encontrado' };
                }
                this.csrf_token = tokenRetry;
            } else {
                this.csrf_token = token;
            }
            
            const formData = new URLSearchParams();
            formData.append('data[_Token][key]', this.csrf_token);
            formData.append('data[_Token][fields]', '');
            formData.append('nome', nome);
            if (uf) formData.append('uf', uf);
            
            const response = await this.session.post(consultUrl, formData.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': this.base_url,
                    'Referer': `${this.base_url}${consultUrl}`,
                    'Cookie': this.cookies || ''
                },
                maxRedirects: 0,
                validateStatus: status => status === 302 || status === 200
            });
            
            return await this._processar_resultado(response);
            
        } catch (error) {
            this.log(`❌ Erro consultarNome: ${error.message}`);
            return { success: false, message: `Erro: ${error.message}` };
        }
    }

    async consultarTelefone(telefone) {
        try {
            if (!await this._ensure_login()) {
                return { success: false, message: 'Falha no login' };
            }
            
            this.log(`🔍 Consultando por telefone: ${telefone}`);
            
            const consultUrl = '/localizador_nacional/consultar/4177';
            const token = await this._get_token_from_page(consultUrl);
            
            if (!token) {
                this.log('❌ Token não encontrado, tentando relogin...');
                await this.forceRelogin();
                const tokenRetry = await this._get_token_from_page(consultUrl);
                if (!tokenRetry) {
                    return { success: false, message: 'Token CSRF não encontrado' };
                }
                this.csrf_token = tokenRetry;
            } else {
                this.csrf_token = token;
            }
            
            const formData = new URLSearchParams();
            formData.append('data[_Token][key]', this.csrf_token);
            formData.append('data[_Token][fields]', '');
            formData.append('telefone', telefone);
            
            const response = await this.session.post(consultUrl, formData.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': this.base_url,
                    'Referer': `${this.base_url}${consultUrl}`,
                    'Cookie': this.cookies || ''
                },
                maxRedirects: 0,
                validateStatus: status => status === 302 || status === 200
            });
            
            return await this._processar_resultado(response);
            
        } catch (error) {
            this.log(`❌ Erro consultarTelefone: ${error.message}`);
            return { success: false, message: `Erro: ${error.message}` };
        }
    }

    async consultarProcesso(cpf, tipo_pessoa = '1') {
        try {
            if (!await this._ensure_login()) {
                return { success: false, message: 'Falha no login' };
            }
            
            this.log(`🔍 Consultando processo por CPF: ${cpf}`);
            
            const consultUrl = '/localizador_nacional/consultar/4814';
            const token = await this._get_token_from_page(consultUrl);
            
            if (!token) {
                this.log('❌ Token não encontrado, tentando relogin...');
                await this.forceRelogin();
                const tokenRetry = await this._get_token_from_page(consultUrl);
                if (!tokenRetry) {
                    return { success: false, message: 'Token CSRF não encontrado' };
                }
                this.csrf_token = tokenRetry;
            } else {
                this.csrf_token = token;
            }
            
            const formData = new URLSearchParams();
            formData.append('data[_Token][key]', this.csrf_token);
            formData.append('data[_Token][fields]', '');
            formData.append('tipo_pessoa', tipo_pessoa);
            formData.append('documento', cpf);
            
            const response = await this.session.post(consultUrl, formData.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': this.base_url,
                    'Referer': `${this.base_url}${consultUrl}`,
                    'Cookie': this.cookies || ''
                },
                maxRedirects: 0,
                validateStatus: status => status === 302 || status === 200
            });
            
            if (response.status === 302) {
                const location = response.headers.location || '/localizador_nacional/resultado';
                const resultPage = await this.session.get(location);
                
                if (resultPage.status === 200) {
                    const data = await this._extract_process_data(resultPage.data);
                    
                    if (data.processos && data.processos.length > 0) {
                        return {
                            success: true,
                            total: data.processos.length,
                            data: data
                        };
                    } else {
                        return {
                            success: false,
                            total: 0,
                            data: null,
                            message: 'Nenhum processo encontrado para este CPF'
                        };
                    }
                }
            }
            
            if (response.status === 200) {
                const data = await this._extract_process_data(response.data);
                if (data.processos && data.processos.length > 0) {
                    return {
                        success: true,
                        total: data.processos.length,
                        data: data
                    };
                }
            }
            
            return { success: false, message: `Falha na consulta. Status: ${response.status}` };
            
        } catch (error) {
            this.log(`❌ Erro consultarProcesso: ${error.message}`);
            return { success: false, message: `Erro: ${error.message}` };
        }
    }

    async consultarSancoes(cpf) {
        try {
            if (!await this._ensure_login()) {
                return { success: false, message: 'Falha no login' };
            }
            
            this.log(`🔍 Consultando sanções por CPF: ${cpf}`);
            
            const consultUrl = '/localizador_nacional/consultar/4882';
            const token = await this._get_token_from_page(consultUrl);
            
            if (!token) {
                this.log('❌ Token não encontrado, tentando relogin...');
                await this.forceRelogin();
                const tokenRetry = await this._get_token_from_page(consultUrl);
                if (!tokenRetry) {
                    return { success: false, message: 'Token CSRF não encontrado' };
                }
                this.csrf_token = tokenRetry;
            } else {
                this.csrf_token = token;
            }
            
            const formData = new URLSearchParams();
            formData.append('data[_Token][key]', this.csrf_token);
            formData.append('data[_Token][fields]', '');
            formData.append('documento', cpf);
            
            const response = await this.session.post(consultUrl, formData.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': this.base_url,
                    'Referer': `${this.base_url}${consultUrl}`,
                    'Cookie': this.cookies || ''
                },
                maxRedirects: 0,
                validateStatus: status => status === 302 || status === 200
            });
            
            if (response.status === 302) {
                const location = response.headers.location || '/localizador_nacional/resultado';
                const resultPage = await this.session.get(location);
                
                if (resultPage.status === 200) {
                    const data = await this._extract_sancoes_data_complete(resultPage.data);
                    
                    if (data.sancoes && data.sancoes.length > 0) {
                        return {
                            success: true,
                            total: data.sancoes.length,
                            data: data
                        };
                    } else {
                        return {
                            success: false,
                            total: 0,
                            data: null,
                            message: 'Nenhuma sanção encontrada para este CPF'
                        };
                    }
                }
            }
            
            if (response.status === 200) {
                const data = await this._extract_sancoes_data_complete(response.data);
                if (data.sancoes && data.sancoes.length > 0) {
                    return {
                        success: true,
                        total: data.sancoes.length,
                        data: data
                    };
                }
            }
            
            return { success: false, message: `Falha na consulta. Status: ${response.status}` };
            
        } catch (error) {
            this.log(`❌ Erro consultarSancoes: ${error.message}`);
            return { success: false, message: `Erro: ${error.message}` };
        }
    }

    async getStatus() {
        return {
            success: true,
            logged_in: this.logged_in,
            cookies: this.cookies ? 'presentes' : 'ausentes',
            credencial_atual: this.currentCredentials ? this.currentCredentials.username : 'nenhuma',
            token_presente: this.csrf_token ? 'sim' : 'não'
        };
    }
}

const consultCenter = new ConsultCenterClient();

// ============================================
// ROTA FOTO DF (DETRAN-DF) - SEM PROXY
// ============================================

app.get('/fotodf', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({
            erro: 'CPF não fornecido',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (!validarCPF(cpfLimpo)) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    try {
        console.log(`📸 Buscando foto DETRAN-DF para CPF: ${cpfLimpo}`);
        
        const url = `https://nexus.api.pm.df.gov.br/api/files/pessoa%2Fimagem%2F${cpfLimpo}%2F${cpfLimpo}_imagem_DETRAN_.jpg`;
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                'Referer': 'https://nexus.api.pm.df.gov.br/'
            },
            timeout: 30000
        });
        
        const contentType = response.headers['content-type'] || 'image/jpeg';
        const data = response.data;
        
        if (data.length < 1024) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Foto não encontrada para este CPF',
                cpf_consultado: cpfLimpo
            });
        }
        
        const base64Image = Buffer.from(data).toString('base64');
        
        res.json({
            sucesso: true,
            fonte: 'DETRAN-DF',
            cpf_consultado: cpfLimpo,
            foto_base64: base64Image,
            formato: contentType,
            tamanho_bytes: data.length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Erro na rota /fotodf:', error.message);
        
        if (error.response) {
            if (error.response.status === 404) {
                return res.status(404).json({
                    sucesso: false,
                    mensagem: 'Foto não encontrada para este CPF',
                    cpf_consultado: cpfLimpo,
                    status: error.response.status
                });
            }
            
            if (error.response.status === 403) {
                return res.status(403).json({
                    sucesso: false,
                    mensagem: 'Acesso negado à API do DETRAN-DF',
                    cpf_consultado: cpfLimpo,
                    status: error.response.status
                });
            }
        }
        
        res.status(500).json({
            sucesso: false,
            erro: 'Erro ao buscar foto',
            mensagem: error.message,
            cpf_consultado: cpfLimpo
        });
    }
});

// ============================================
// ROTAS DA API
// ============================================

app.get('/consultcenter/status', validarApiKey, async (req, res) => {
    try {
        const status = await consultCenter.getStatus();
        res.json({
            sucesso: true,
            consultcenter: status,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            sucesso: false,
            erro: error.message
        });
    }
});

app.get('/discord', validarApiKey, async (req, res) => {
    try {
        const { userid } = req.query;
        
        if (!userid) {
            return res.status(400).json({
                erro: 'userid não fornecido',
                mensagem: 'Informe o userid do Discord no parâmetro: userid=123456789012345678'
            });
        }
        
        if (!/^\d+$/.test(userid)) {
            return res.status(400).json({
                erro: 'userid inválido',
                mensagem: 'O userid deve conter apenas números (ID do Discord)'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta DISCORD para userid: ${userid}`);
        
        const url = `https://belawer-api-tracker-discord-4-0.vercel.app/api/all-data?userId=${userid}`;
        
        const response = await axios.get(url, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });
        
        res.json({
            sucesso: true,
            tipo_consulta: 'DISCORD',
            userid_consultado: userid,
            consulta_realizada_em: new Date().toISOString(),
            dados: response.data
        });
        
    } catch (error) {
        console.error('Erro na consulta DISCORD:', error.message);
        
        if (error.response) {
            return res.status(error.response.status).json({
                sucesso: false,
                erro: 'Erro na API externa',
                status: error.response.status,
                mensagem: error.response.data?.message || error.message,
                userid_consultado: req.query.userid
            });
        }
        
        res.status(500).json({
            sucesso: false,
            erro: 'Erro interno do servidor',
            mensagem: error.message,
            userid_consultado: req.query.userid
        });
    }
});

app.get('/cpf', validarApiKey, async (req, res) => {
    try {
        let { cpf } = req.query;
        
        if (!cpf) {
            return res.status(400).json({
                erro: 'CPF não fornecido',
                mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
            });
        }
        
        const cpfLimpo = cpf.replace(/\D/g, '');
        
        if (!validarCPF(cpfLimpo)) {
            return res.status(400).json({
                erro: 'CPF inválido',
                mensagem: 'O CPF deve conter 11 dígitos numéricos'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta CPF: ${cpfLimpo}`);
        
        // ============================================
        // CONSULTA SUS VIA SISREG III (SCRAPING)
        // ============================================
        let resultadoSUS = null;
        try {
            console.log(`🔍 Consultando SISREG III para CPF: ${cpfLimpo}`);
            
            const html = await consultarPacienteSISREG(cpfLimpo);
            
            if (html.erro) {
                resultadoSUS = {
                    status: 'erro',
                    erro: html.erro,
                    timestamp: new Date().toISOString()
                };
            } else {
                const dados = extrairDadosSISREG(html);
                
                if (dados.erro || (!dados.cns && !dados.nome)) {
                    resultadoSUS = {
                        status: 'erro',
                        erro: dados.erro || 'Paciente não encontrado no SISREG',
                        timestamp: new Date().toISOString()
                    };
                } else {
                    resultadoSUS = {
                        status: 'sucesso',
                        dados: dados,
                        timestamp: new Date().toISOString()
                    };
                    console.log(`✅ SISREG OK para CPF: ${cpfLimpo}`);
                }
            }
        } catch (error) {
            console.error('[SISREG] Erro na consulta:', error.message);
            resultadoSUS = {
                status: 'erro',
                erro: error.message,
                timestamp: new Date().toISOString()
            };
        }
        
        // ============================================
        // CONSULTA RF (Receita Federal)
        // ============================================
        let resultadoRF = null;
        try {
            console.log(`🔍 Consultando RF para CPF: ${cpfLimpo}`);
            
            const rfResponse = await axios.get('https://api.eyerofgodfinder.com/brasil/cpf', {
                params: {
                    token: '1c47093716d898f265f107de8796fbabe97c5ea796df6b72',
                    text: cpfLimpo
                },
                timeout: 10000
            });
            
            if (rfResponse.data) {
                resultadoRF = {
                    status: 'sucesso',
                    dados: rfResponse.data,
                    timestamp: new Date().toISOString()
                };
                console.log(`✅ RF OK para ${cpfLimpo}`);
            } else {
                resultadoRF = {
                    status: 'erro',
                    erro: 'CPF não encontrado na Receita Federal',
                    timestamp: new Date().toISOString()
                };
            }
        } catch (error) {
            console.error('[RF] Erro na consulta:', error.message);
            resultadoRF = {
                status: 'erro',
                erro: error.message,
                timestamp: new Date().toISOString()
            };
        }
        
        // ============================================
        // CONSULTA BigDataCorp
        // ============================================
        let resultadoBigData = null;
        try {
            console.log(`🔍 Consultando BigData para CPF: ${cpfLimpo}`);
            
            await garantirSessaoBigData();
            
            const dadosCompletos = await consultarBigDataCompleto(cpfLimpo);
            
            if (dadosCompletos) {
                const dadosFormatados = extrairDadosFormatadosBigData(dadosCompletos);
                resultadoBigData = {
                    status: 'sucesso',
                    dados: dadosFormatados,
                    dados_brutos: dadosCompletos.dados,
                    timestamp: new Date().toISOString()
                };
                console.log(`✅ BigData OK para ${cpfLimpo}`);
            } else {
                resultadoBigData = {
                    status: 'erro',
                    erro: 'CPF não encontrado na BigDataCorp',
                    timestamp: new Date().toISOString()
                };
            }
        } catch (error) {
            console.error('[BigData] Erro na consulta:', error.message);
            resultadoBigData = {
                status: 'erro',
                erro: error.message,
                timestamp: new Date().toISOString()
            };
        }
        
        res.json({
            tipo_consulta: 'CPF',
            valor_consultado: cpfLimpo,
            consulta_realizada_em: new Date().toISOString(),
            total_fontes: 3,
            resultados: {
                'SUS (SISREG III)': resultadoSUS,
                'RF (Receita Federal)': resultadoRF,
                'BigDataCorp': resultadoBigData
            }
        });
        
    } catch (error) {
        console.error('Erro na consulta CPF:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/nome', validarApiKey, async (req, res) => {
    try {
        let { nome } = req.query;
        
        if (!nome) {
            return res.status(400).json({
                erro: 'Nome não fornecido',
                mensagem: 'Informe o nome no parâmetro: nome=João Silva'
            });
        }
        
        if (!validarNome(nome)) {
            return res.status(400).json({
                erro: 'Nome inválido',
                mensagem: 'O nome deve ter pelo menos 3 caracteres'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta NOME: ${nome}`);
        
        const resultadoBR43M = await consultarAPI('BR43M', APIS.nome.BR43M, nome);
        const resultadoConsultCenter = await consultCenter.consultarNome(nome);
        
        res.json({
            tipo_consulta: 'NOME',
            valor_consultado: nome,
            consulta_realizada_em: new Date().toISOString(),
            fontes: {
                'BR43M (Nacional)': {
                    status: resultadoBR43M.status,
                    ...(resultadoBR43M.status === 'sucesso' 
                        ? { dados: resultadoBR43M.dados } 
                        : { erro: resultadoBR43M.erro }),
                    timestamp: resultadoBR43M.timestamp
                },
                'ConsultCenter (Nacional)': {
                    status: resultadoConsultCenter.success ? 'sucesso' : 'erro',
                    ...(resultadoConsultCenter.success 
                        ? { dados: resultadoConsultCenter } 
                        : { erro: resultadoConsultCenter.message || 'Falha na consulta' }),
                    timestamp: new Date().toISOString()
                }
            }
        });
        
    } catch (error) {
        console.error('Erro na consulta Nome:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/nomemae', validarApiKey, async (req, res) => {
    try {
        let { nome } = req.query;
        
        if (!nome) {
            return res.status(400).json({
                erro: 'Nome da mãe não fornecido',
                mensagem: 'Informe o nome da mãe no parâmetro: nome=Maria Silva'
            });
        }
        
        if (!validarNome(nome)) {
            return res.status(400).json({
                erro: 'Nome inválido',
                mensagem: 'O nome da mãe deve ter pelo menos 3 caracteres'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta NOME DA MÃE: ${nome}`);
        
        const resultados = await consultarMultiplasAPIs(APIS.nome_mae, nome);
        
        res.json({
            tipo_consulta: 'NOME DA MÃE',
            valor_consultado: nome,
            consulta_realizada_em: new Date().toISOString(),
            total_fontes: Object.keys(APIS.nome_mae).length,
            resultados
        });
        
    } catch (error) {
        console.error('Erro na consulta Nome da Mãe:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/nomepai', validarApiKey, async (req, res) => {
    try {
        let { nome } = req.query;
        
        if (!nome) {
            return res.status(400).json({
                erro: 'Nome do pai não fornecido',
                mensagem: 'Informe o nome do pai no parâmetro: nome=José Silva'
            });
        }
        
        if (!validarNome(nome)) {
            return res.status(400).json({
                erro: 'Nome inválido',
                mensagem: 'O nome do pai deve ter pelo menos 3 caracteres'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta NOME DO PAI: ${nome}`);
        
        const resultados = await consultarMultiplasAPIs(APIS.nome_pai, nome);
        
        res.json({
            tipo_consulta: 'NOME DO PAI',
            valor_consultado: nome,
            consulta_realizada_em: new Date().toISOString(),
            total_fontes: Object.keys(APIS.nome_pai).length,
            resultados
        });
        
    } catch (error) {
        console.error('Erro na consulta Nome do Pai:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/placa', validarApiKey, async (req, res) => {
    try {
        let { placa } = req.query;
        
        if (!placa) {
            return res.status(400).json({
                erro: 'Placa não fornecida',
                mensagem: 'Informe a placa no parâmetro: placa=ABC1234'
            });
        }
        
        if (!validarPlaca(placa)) {
            return res.status(400).json({
                erro: 'Placa inválida',
                mensagem: 'Formato de placa inválido. Use ABC1234 ou ABC1D23'
            });
        }
        
        const placaLimpa = placa.trim().toUpperCase().replace(/\s/g, '');
        
        console.log(`[${new Date().toISOString()}] Consulta PLACA: ${placaLimpa}`);
        
        const resultadosExistentes = await consultarMultiplasAPIs(APIS.placa, placaLimpa);
        
        let resultadoSSPDS = null;
        try {
            const sspdsResult = await sspdsCEClient.consultarPlaca(placaLimpa);
            if (sspdsResult.success && sspdsResult.html) {
                const dadosExtraidos = sspdsCEClient.extrairDadosVeiculo(sspdsResult.html);
                resultadoSSPDS = {
                    status: 'sucesso',
                    dados: dadosExtraidos,
                    timestamp: new Date().toISOString()
                };
            } else {
                resultadoSSPDS = {
                    status: 'erro',
                    erro: sspdsResult.message || 'Placa não encontrada no SSPDS-CE',
                    timestamp: new Date().toISOString()
                };
            }
        } catch (error) {
            console.error('[SSPDS-CE] Erro na consulta:', error.message);
            resultadoSSPDS = {
                status: 'erro',
                erro: error.message,
                timestamp: new Date().toISOString()
            };
        }
        
        const todosResultados = {
            ...resultadosExistentes,
            'SSPDS-CE (Detran-CE)': resultadoSSPDS
        };
        
        res.json({
            tipo_consulta: 'PLACA',
            valor_consultado: placaLimpa,
            consulta_realizada_em: new Date().toISOString(),
            total_fontes: Object.keys(todosResultados).length,
            resultados: todosResultados
        });
        
    } catch (error) {
        console.error('Erro na consulta Placa:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/sspds/placa', validarApiKey, async (req, res) => {
    try {
        let { placa } = req.query;
        
        if (!placa) {
            return res.status(400).json({
                erro: 'Placa não fornecida',
                mensagem: 'Informe a placa no parâmetro: placa=ABC1234'
            });
        }
        
        if (!validarPlaca(placa)) {
            return res.status(400).json({
                erro: 'Placa inválida',
                mensagem: 'Formato de placa inválido. Use ABC1234 ou ABC1D23'
            });
        }
        
        const placaLimpa = placa.trim().toUpperCase().replace(/\s/g, '');
        
        console.log(`[${new Date().toISOString()}] Consulta SSPDS-CE PLACA: ${placaLimpa}`);
        
        const resultado = await sspdsCEClient.consultarPlaca(placaLimpa);
        
        if (!resultado.success || !resultado.html) {
            return res.status(404).json({
                sucesso: false,
                mensagem: resultado.message || 'Placa não encontrada no SSPDS-CE',
                placa_consultada: placaLimpa
            });
        }
        
        const dadosExtraidos = sspdsCEClient.extrairDadosVeiculo(resultado.html);
        
        res.json({
            sucesso: true,
            fonte: 'SSPDS-CE (Detran-CE)',
            placa_consultada: placaLimpa,
            dados: dadosExtraidos,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Erro na rota /sspds/placa:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/sspds/status', validarApiKey, async (req, res) => {
    try {
        const loggedIn = await sspdsCEClient.ensureLogin();
        res.json({
            sucesso: true,
            status: loggedIn ? 'conectado' : 'desconectado',
            mensagem: loggedIn ? 'SSPDS-CE disponível' : 'SSPDS-CE indisponível',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            sucesso: false,
            erro: error.message
        });
    }
});

app.get('/bnmp', validarApiKey, async (req, res) => {
    try {
        let { cpf } = req.query;
        
        if (!cpf) {
            return res.status(400).json({
                erro: 'CPF não fornecido',
                mensagem: 'Informe o CPF'
            });
        }
        
        const cpfLimpo = cpf.replace(/\D/g, '');
        
        if (!validarCPF(cpfLimpo)) {
            return res.status(400).json({
                erro: 'CPF inválido',
                mensagem: 'O CPF deve conter 11 dígitos numéricos'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta BNMP para CPF: ${cpfLimpo}`);
        
        const promises = Object.entries(APIS.bnmp).map(([nome, config]) => 
            consultarAPI(nome, config, cpfLimpo, 'cpf')
        );
        
        const resultadosArray = await Promise.all(promises);
        
        const resultados = {};
        resultadosArray.forEach(resultado => {
            let dadosFormatados = resultado.dados;
            
            if (resultado.status === 'erro') {
                dadosFormatados = 'CPF Não encontrado em BNMP';
            } else if (resultado.dados && (resultado.dados.success === false || resultado.dados.erro)) {
                dadosFormatados = 'CPF Não encontrado em BNMP';
            }
            
            resultados[resultado.fonte] = {
                status: resultado.status,
                ...(resultado.status === 'sucesso' 
                    ? { dados: dadosFormatados } 
                    : { erro: dadosFormatados }),
                timestamp: resultado.timestamp
            };
        });
        
        res.json({
            tipo_consulta: 'BNMP - Banco Nacional de Mandados de Prisão',
            valor_consultado: cpfLimpo,
            consulta_realizada_em: new Date().toISOString(),
            total_fontes: Object.keys(APIS.bnmp).length,
            resultados
        });
        
    } catch (error) {
        console.error('Erro na consulta BNMP:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/telefone', validarApiKey, async (req, res) => {
    try {
        let { telefone } = req.query;
        
        if (!telefone) {
            return res.status(400).json({
                erro: 'Telefone não fornecido',
                mensagem: 'Informe o telefone no parâmetro: telefone=11999999999'
            });
        }
        
        const telefoneLimpo = telefone.replace(/\D/g, '');
        
        if (telefoneLimpo.length < 10 || telefoneLimpo.length > 11) {
            return res.status(400).json({
                erro: 'Telefone inválido',
                mensagem: 'O telefone deve ter 10 ou 11 dígitos (DDD + número)'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta TELEFONE: ${telefoneLimpo}`);
        
        const resultado = await consultCenter.consultarTelefone(telefoneLimpo);
        
        if (!resultado.success) {
            return res.status(404).json({
                sucesso: false,
                mensagem: resultado.message || 'Falha na consulta',
                telefone_consultado: telefoneLimpo
            });
        }
        
        res.json({
            tipo_consulta: 'TELEFONE',
            valor_consultado: telefoneLimpo,
            consulta_realizada_em: new Date().toISOString(),
            fonte: 'ConsultCenter',
            ...resultado
        });
        
    } catch (error) {
        console.error('Erro na consulta Telefone:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/processo', validarApiKey, async (req, res) => {
    try {
        let { cpf } = req.query;
        
        if (!cpf) {
            return res.status(400).json({
                erro: 'CPF não fornecido',
                mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
            });
        }
        
        const cpfLimpo = cpf.replace(/\D/g, '');
        
        if (!validarCPF(cpfLimpo)) {
            return res.status(400).json({
                erro: 'CPF inválido',
                mensagem: 'O CPF deve conter 11 dígitos numéricos'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta PROCESSO para CPF: ${cpfLimpo}`);
        
        const resultado = await consultCenter.consultarProcesso(cpfLimpo);
        
        if (!resultado.success) {
            return res.status(404).json({
                sucesso: false,
                mensagem: resultado.message || 'Falha na consulta',
                cpf_consultado: cpfLimpo
            });
        }
        
        res.json({
            tipo_consulta: 'PROCESSOS JUDICIAIS',
            valor_consultado: cpfLimpo,
            consulta_realizada_em: new Date().toISOString(),
            fonte: 'ConsultCenter',
            ...resultado
        });
        
    } catch (error) {
        console.error('Erro na consulta Processo:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/sancoes', validarApiKey, async (req, res) => {
    try {
        let { cpf } = req.query;
        
        if (!cpf) {
            return res.status(400).json({
                erro: 'CPF não fornecido',
                mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
            });
        }
        
        const cpfLimpo = cpf.replace(/\D/g, '');
        
        if (!validarCPF(cpfLimpo)) {
            return res.status(400).json({
                erro: 'CPF inválido',
                mensagem: 'O CPF deve conter 11 dígitos numéricos'
            });
        }
        
        console.log(`[${new Date().toISOString()}] Consulta SANCOES para CPF: ${cpfLimpo}`);
        
        const resultadoSancoes = await consultCenter.consultarSancoes(cpfLimpo);
        const resultadoBNMP = await consultarAPI('BNMP', APIS.bnmp.BNMP, cpfLimpo, 'cpf');
        
        let dadosBNMP = resultadoBNMP.dados;
        if (resultadoBNMP.status === 'erro') {
            dadosBNMP = 'CPF Não encontrado em BNMP';
        } else if (resultadoBNMP.dados && (resultadoBNMP.dados.success === false || resultadoBNMP.dados.erro)) {
            dadosBNMP = 'CPF Não encontrado em BNMP';
        }
        
        res.json({
            tipo_consulta: 'SANÇÕES E MANDADOS DE PRISÃO',
            valor_consultado: cpfLimpo,
            consulta_realizada_em: new Date().toISOString(),
            fontes: {
                'ConsultCenter (Sanções)': {
                    status: resultadoSancoes.success ? 'sucesso' : 'erro',
                    ...(resultadoSancoes.success 
                        ? { dados: resultadoSancoes } 
                        : { erro: resultadoSancoes.message || 'Falha na consulta' }),
                    timestamp: new Date().toISOString()
                },
                'BNMP (Mandados de Prisão)': {
                    status: resultadoBNMP.status,
                    dados: dadosBNMP,
                    timestamp: resultadoBNMP.timestamp
                }
            }
        });
        
    } catch (error) {
        console.error('Erro na consulta Sanções:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

// ============================================
// ROTA FOTO MA (SIISP-MA)
// ============================================

app.get('/fotoma', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({
            erro: 'CPF não fornecido',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (!validarCPF(cpfLimpo)) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    try {
        console.log(`📸 Consultando FOTO MA (SIISP) para CPF: ${cpfLimpo}`);
        
        const xmlResponse = await consultarPresoMA(cpfLimpo);
        const dados = extrairDadosPresoMA(xmlResponse);
        
        if ((!dados.nome || dados.nome === '') && (!dados.cpf || dados.cpf === '') && (!dados.foto || dados.foto === '')) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Nenhum resultado encontrado para este CPF no SIISP-MA',
                cpf_consultado: cpfLimpo,
                timestamp: new Date().toISOString()
            });
        }
        
        const dadosPreso = {
            nome: dados.nome || 'Não informado',
            cpf: dados.cpf || cpfLimpo,
            data_nascimento: dados.data_nascimento || 'Não informada',
            pai: dados.pai || 'Não informado',
            mae: dados.mae || 'Não informado',
            naturalidade: dados.naturalidade || 'Não informada',
            sexo: dados.sexo || 'Não informado'
        };
        
        let fotoBase64 = null;
        let formato = null;
        
        if (dados.foto) {
            const matches = dados.foto.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
            if (matches) {
                fotoBase64 = matches[2];
                formato = `image/${matches[1]}`;
            } else if (dados.foto.startsWith('data:image')) {
                const parts = dados.foto.split(',');
                if (parts.length === 2) {
                    const mimeMatch = parts[0].match(/image\/([a-zA-Z]+)/);
                    fotoBase64 = parts[1];
                    formato = mimeMatch ? `image/${mimeMatch[1]}` : 'image/jpeg';
                }
            } else {
                fotoBase64 = dados.foto;
                formato = 'image/jpeg';
            }
        }
        
        res.json({
            sucesso: true,
            fonte: 'SIISP-MA',
            cpf_consultado: cpfLimpo,
            dados: dadosPreso,
            foto_base64: fotoBase64,
            formato: formato,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Erro na rota /fotoma:', error);
        res.status(500).json({
            sucesso: false,
            erro: error.message,
            cpf_consultado: cpfLimpo,
            timestamp: new Date().toISOString()
        });
    }
});

// ============================================
// ROTA FOTO MG (DETRAN-MG)
// ============================================

app.get('/fotomg', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({ 
            erro: 'CPF é obrigatório',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (!validarCPF(cpfLimpo)) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    const urlFoto = `https://empresas.detran.mg.gov.br/sdaf/ImagensBiometria/Foto/${cpfLimpo}.jpg`;
    const urlAssinatura = `https://empresas.detran.mg.gov.br/sdaf/ImagensBiometria/Assinatura/${cpfLimpo}.jpg`;

    try {
        console.log(`📸 Buscando biometria para CPF: ${cpfLimpo}`);
        
        const [fotoImg, assinaturaImg] = await Promise.all([
            fetchImage(urlFoto),
            fetchImage(urlAssinatura)
        ]);

        const width = fotoImg.width + assinaturaImg.width + 20;
        const height = Math.max(fotoImg.height, assinaturaImg.height);

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        ctx.drawImage(fotoImg, 0, 0);
        ctx.drawImage(assinaturaImg, fotoImg.width + 20, 0);

        const buffer = canvas.toBuffer('image/jpeg');
        const fotoBase64 = buffer.toString('base64');
        
        res.json({
            sucesso: true,
            cpf_consultado: cpfLimpo,
            foto_base64: fotoBase64,
            formato: 'image/jpeg',
            dimensoes: {
                largura: width,
                altura: height
            }
        });

    } catch (error) {
        console.error("Erro FOTO MG:", error.message);
        res.status(500).json({ 
            sucesso: false,
            erro: 'Erro ao buscar imagens',
            detalhe: error.message,
            cpf_consultado: cpfLimpo
        });
    }
});

app.get('/fotomg/foto', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({ 
            erro: 'CPF é obrigatório',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (!validarCPF(cpfLimpo)) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    const urlFoto = `https://empresas.detran.mg.gov.br/sdaf/ImagensBiometria/Foto/${cpfLimpo}.jpg`;

    try {
        console.log(`📸 Buscando foto para CPF: ${cpfLimpo}`);
        
        const fotoImg = await fetchImage(urlFoto);
        
        const canvas = createCanvas(fotoImg.width, fotoImg.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(fotoImg, 0, 0);
        
        const buffer = canvas.toBuffer('image/jpeg');
        const fotoBase64 = buffer.toString('base64');
        
        res.json({
            sucesso: true,
            cpf_consultado: cpfLimpo,
            foto_base64: fotoBase64,
            formato: 'image/jpeg'
        });

    } catch (error) {
        console.error("Erro FOTO MG:", error.message);
        res.status(500).json({ 
            sucesso: false,
            erro: 'Erro ao buscar imagem',
            detalhe: error.message,
            cpf_consultado: cpfLimpo
        });
    }
});

app.get('/fotomg/assinatura', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({ 
            erro: 'CPF é obrigatório',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (!validarCPF(cpfLimpo)) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    const urlAssinatura = `https://empresas.detran.mg.gov.br/sdaf/ImagensBiometria/Assinatura/${cpfLimpo}.jpg`;

    try {
        console.log(`📸 Buscando assinatura para CPF: ${cpfLimpo}`);
        
        const assinaturaImg = await fetchImage(urlAssinatura);
        
        const canvas = createCanvas(assinaturaImg.width, assinaturaImg.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(assinaturaImg, 0, 0);
        
        const buffer = canvas.toBuffer('image/jpeg');
        const assinaturaBase64 = buffer.toString('base64');
        
        res.json({
            sucesso: true,
            cpf_consultado: cpfLimpo,
            assinatura_base64: assinaturaBase64,
            formato: 'image/jpeg'
        });

    } catch (error) {
        console.error("Erro FOTO MG:", error.message);
        res.status(500).json({ 
            sucesso: false,
            erro: 'Erro ao buscar assinatura',
            detalhe: error.message,
            cpf_consultado: cpfLimpo
        });
    }
});

const fotoEs = new FotoEs(USER_ES, PASS_ES);

// ============================================
// ROTA FOTO ES (SISP-ES)
// ============================================

app.get('/fotoes', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({
            erro: 'CPF não fornecido',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (cpfLimpo.length !== 11) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    try {
        const resultado = await fotoEs.consulta(cpfLimpo);
        
        if (!resultado) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Nenhum resultado encontrado para este CPF',
                cpf_consultado: cpfLimpo
            });
        }
        
        if (resultado.foto && req.query.formato === 'imagem') {
            const buffer = Buffer.from(resultado.foto, 'base64');
            res.setHeader('Content-Type', 'image/jpeg');
            res.send(buffer);
        } else {
            res.json({
                sucesso: true,
                dados: resultado
            });
        }
        
    } catch (error) {
        console.error('Erro na rota /fotoes:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/fotoes/foto', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({
            erro: 'CPF não fornecido',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (cpfLimpo.length !== 11) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    try {
        const resultado = await fotoEs.consulta(cpfLimpo);
        
        if (!resultado || !resultado.foto) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Foto não encontrada para este CPF'
            });
        }
        
        res.json({
            sucesso: true,
            foto_base64: resultado.foto,
            formato: 'image/jpeg'
        });
        
    } catch (error) {
        console.error('Erro na rota /fotoes/foto:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

// ============================================
// ROTA RG - ATUALIZADA
// ============================================

app.get('/rg', validarApiKey, async (req, res) => {
    const { rg } = req.query;
    
    if (!rg) {
        return res.status(400).json({
            erro: 'RG não fornecido',
            mensagem: 'Informe o RG no parâmetro: rg=123456789'
        });
    }
    
    const rgLimpo = rg.replace(/\D/g, '');
    
    if (!validarRG(rgLimpo)) {
        return res.status(400).json({
            erro: 'RG inválido',
            mensagem: 'O RG deve conter pelo menos 5 dígitos'
        });
    }
    
    try {
        console.log(`[${new Date().toISOString()}] [CARTORIO-MS] 📥 Nova requisição para RG: ${rgLimpo}`);
        
        const resultado = await consultarPorRG(rgLimpo);
        
        if (!resultado) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Nenhum resultado encontrado para este RG',
                rg_consultado: rgLimpo
            });
        }
        
        if (resultado.foto && req.query.formato === 'imagem') {
            let fotoBase64 = resultado.foto;
            if (fotoBase64.includes(',')) {
                fotoBase64 = fotoBase64.split(',')[1];
            }
            const buffer = Buffer.from(fotoBase64, 'base64');
            res.setHeader('Content-Type', 'image/png');
            res.send(buffer);
        } else {
            res.json({
                sucesso: true,
                dados: resultado
            });
        }
        
    } catch (error) {
        console.error('Erro na rota /rg:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

// ============================================
// ROTA FOTO PR (SESP-PR)
// ============================================

app.get('/fotopr', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({
            erro: 'CPF não fornecido',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (!validarCPF(cpfLimpo)) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    try {
        const resultado = await consultarFotoPRPrincipal(cpfLimpo);
        
        if (!resultado) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Nenhum resultado encontrado para este CPF',
                cpf_consultado: cpfLimpo
            });
        }
        
        if (resultado.foto_base64 && req.query.formato === 'imagem') {
            const buffer = Buffer.from(resultado.foto_base64, 'base64');
            res.setHeader('Content-Type', 'image/jpeg');
            res.send(buffer);
        } else {
            res.json({
                sucesso: true,
                dados: resultado
            });
        }
        
    } catch (error) {
        console.error('Erro na rota /fotopr:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/fotopr/foto', validarApiKey, async (req, res) => {
    const { cpf } = req.query;
    
    if (!cpf) {
        return res.status(400).json({
            erro: 'CPF não fornecido',
            mensagem: 'Informe o CPF no parâmetro: cpf=12345678901'
        });
    }
    
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (!validarCPF(cpfLimpo)) {
        return res.status(400).json({
            erro: 'CPF inválido',
            mensagem: 'O CPF deve conter 11 dígitos numéricos'
        });
    }
    
    try {
        const resultado = await consultarFotoPRPrincipal(cpfLimpo);
        
        if (!resultado || !resultado.foto_base64) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Foto não encontrada para este CPF'
            });
        }
        
        res.json({
            sucesso: true,
            foto_base64: resultado.foto_base64,
            formato: 'image/jpeg'
        });
        
    } catch (error) {
        console.error('Erro na rota /fotopr/foto:', error);
        res.status(500).json({
            erro: 'Erro interno do servidor',
            mensagem: error.message
        });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>_X</title>
            <style>
                body {
                    background-color: black;
                    margin: 0;
                    padding: 0;
                    min-height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                }
                video {
                    width: 500px;
                    max-width: 80%;
                    height: auto;
                    display: block;
                }
            </style>
        </head>
        <body>
            <video id="mainVideo" loop>
                <source src="https://files.catbox.moe/q9k0gp.MP4" type="video/mp4">
            </video>
            <script>
                const video = document.getElementById('mainVideo');
                
                document.body.addEventListener('click', function() {
                    video.muted = false;
                    video.play();
                }, { once: true });
                
                video.muted = true;
                video.play();
            </script>
        </body>
        </html>
    `);
});

// ============================================
// INICIALIZAÇÃO
// ============================================

async function iniciarServidor() {
    console.log(`\n✅ API MULTI-CONSULTA rodando em http://localhost:${PORT}`);
    console.log('\n📋 ENDPOINTS DISPONÍVEIS:\n');
    console.log('🔍 CONSULTAS GERAIS:');
    console.log(`   GET /cpf?apikey=neymarconvocado&cpf=12345678901 (SISREG + RF + BigData)`);
    console.log(`   GET /nome?apikey=neymarconvocado&nome=João Silva (BR43M + ConsultCenter)`);
    console.log(`   GET /nomemae?apikey=neymarconvocado&nome=Maria Silva`);
    console.log(`   GET /nomepai?apikey=neymarconvocado&nome=José Silva`);
    console.log(`   GET /placa?apikey=neymarconvocado&placa=ABC1234 (RF + SSPDS-CE)`);
    console.log(`   GET /sspds/placa?apikey=neymarconvocado&placa=ABC1234 (Apenas SSPDS-CE)`);
    console.log(`   GET /bnmp?apikey=neymarconvocado&cpf=12345678901`);
    console.log(`   GET /discord?apikey=neymarconvocado&userId=123456789012345678\n`);
    console.log('📱 CONSULTAS CONSULTCENTER:');
    console.log(`   GET /telefone?apikey=neymarconvocado&telefone=11999999999`);
    console.log(`   GET /processo?apikey=neymarconvocado&cpf=12345678901`);
    console.log(`   GET /sancoes?apikey=neymarconvocado&cpf=12345678901 (Sanções + BNMP)`);
    console.log(`   GET /consultcenter/status?apikey=neymarconvocado (Status)\n`);
    console.log('📸 FOTOS:');
    console.log(`   GET /fotoma?apikey=neymarconvocado&cpf=12345678901 (SIISP-MA)`);
    console.log(`   GET /fotomg?apikey=neymarconvocado&cpf=12345678901 (DETRAN-MG)`);
    console.log(`   GET /fotoes?apikey=neymarconvocado&cpf=12345678901 (SISP-ES)`);
    console.log(`   GET /fotopr?apikey=neymarconvocado&cpf=12345678901 (SESP-PR)`);
    console.log(`   GET /fotodf?apikey=neymarconvocado&cpf=12345678901 (DETRAN-DF)\n`);
    console.log('🆔 CONSULTA POR RG:');
    console.log(`   GET /rg?apikey=neymarconvocado&rg=123456789 (Cartório-MS)\n`);
    console.log('🚗 SSPDS-CE:');
    console.log(`   GET /sspds/status?apikey=neymarconvocado (Status do SSPDS-CE)\n`);
    console.log('📊 BIGDATA:');
    console.log(`   GET /bigdata?apikey=neymarconvocado&cpf=12345678901`);
    console.log(`   GET /bigdata/status?apikey=neymarconvocado\n`);
    
    // Inicializar SISREG III
    try {
        await inicializarSessaoPoolSISREG();
        console.log('✅ SISREG III inicializado com sucesso');
    } catch (e) {
        console.log('⚠️ SISREG III falhou:', e.message);
    }
    
    // Inicializar IDMA
    try {
        await fazerLoginIDMA();
        console.log('✅ IDMA inicializado com sucesso');
    } catch (e) {
        console.log('⚠️ IDMA falhou:', e.message);
    }
    
    // Inicializar SIISP-MA
    try {
        await fazerLoginMA();
        console.log('✅ Login MA realizado com sucesso');
    } catch (e) {
        console.log('⚠️ Login MA inicial falhou:', e.message);
    }
    
    // Inicializar SISP-ES
    try {
        await fotoEs.login();
        console.log('✅ Login ES realizado com sucesso');
    } catch (e) {
        console.log('⚠️ Login ES inicial falhou:', e.message);
    }
    
    // Inicializar Cartório-MS
    try {
        await loginMS();
        console.log('✅ Login MS realizado com sucesso');
    } catch (e) {
        console.log('⚠️ Login MS inicial falhou:', e.message);
    }
    
    // Inicializar ConsultCenter
    try {
        const status = await consultCenter.getStatus();
        if (status.logged_in) {
            console.log('✅ ConsultCenter conectado com sucesso');
        } else {
            console.log('⚠️ ConsultCenter não está logado');
        }
    } catch (e) {
        console.log('⚠️ ConsultCenter indisponível:', e.message);
    }
    
    // Inicializar SSPDS-CE
    try {
        await sspdsCEClient.login();
        if (sspdsCEClient.logged_in) {
            console.log('✅ SSPDS-CE conectado com sucesso');
        } else {
            console.log('⚠️ SSPDS-CE não está logado');
        }
    } catch (e) {
        console.log('⚠️ SSPDS-CE indisponível:', e.message);
    }
    
    // Inicializar BigData
    try {
        const valid = await verificarBigDataSession();
        if (valid) {
            console.log('✅ BigData conectado com sucesso');
        } else {
            console.log('⚠️ BigData indisponível');
        }
    } catch (e) {
        console.log('⚠️ BigData indisponível:', e.message);
    }
    
    console.log(`\n✨ API COMPLETA PRONTA PARA USO!\n`);
    
    // Manutenção automática do SISREG a cada 4 minutos
    setInterval(async () => {
        console.log('\n🔄 Executando manutenção automática do SISREG...');
        await manterSessoesAtivasSISREG();
    }, 4 * 60 * 1000);
}

app.listen(PORT, '0.0.0.0', iniciarServidor);