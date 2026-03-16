const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, relative, resolve } = require('path')
const { spawnSync } = require('child_process')
const { parse } = require('dotenv')

const composeFile = resolve(process.cwd(), 'edge/docker-compose/docker-compose.yaml')
const generatedDir = resolve(process.cwd(), 'edge/docker-compose/config/.generated')

const componentConfigs = [
  {
    name: 'mcp-gateway',
    template: resolve(process.cwd(), 'edge/docker-compose/config/mcp-gateway/config.yaml'),
    envFile: resolve(process.cwd(), 'edge/docker-compose/config/mcp-gateway/.env'),
  },
  {
    name: 'discovery-agent',
    template: resolve(process.cwd(), 'edge/docker-compose/config/discovery-agent/config.yaml'),
    envFile: resolve(process.cwd(), 'edge/docker-compose/config/discovery-agent/.env'),
  },
]

const requiredEnvVars = [
  'PLAINID_RUNTIME_BASE_URL',
  'PLAINID_TOOLS_ASSET',
  'PLAINID_EMPTY_ON_ERROR',
  'PLAINID_MCP_GATEWAY_ADDR',
  'BANK_MCP_URL',
  'LOG_LEVEL',
  'PLAINID_API_URL',
  'PLAINID_DISCOVERY_URL',
  'POP_ID',
  'ENVIRONMENT_ID',
  'PLAINID_MCP_GATEWAY_URL',
  'PLAINID_CLIENT_ID',
  'PLAINID_CLIENT_SECRET',
]

const requiredTemplateVars = [
  'PLAINID_CLIENT_ID',
  'PLAINID_CLIENT_SECRET',
]

function parseEnv(path) {
  if (!existsSync(path)) {
    return {}
  }

  return parse(readFileSync(path))
}

function renderTemplate(text, env) {
  return text.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (_, varNameCurly, varNamePlain) => {
    const key = varNameCurly || varNamePlain
    const value = env[key]
    if (value === undefined) {
      return ''
    }
    return value
  })
}

const mergedEnv = { ...process.env }
const serviceDebug = new Map()

for (const component of componentConfigs) {
  const componentEnv = parseEnv(component.envFile)

  for (const [key, value] of Object.entries(componentEnv)) {
    if (value !== '') {
      mergedEnv[key] = value
    }
  }

  if (componentEnv.PLAINID_CLIENT_ID) {
    serviceDebug.set(`${component.name}:clientId`, Boolean(componentEnv.PLAINID_CLIENT_ID))
  } else {
    serviceDebug.set(`${component.name}:clientId`, false)
  }

  if (componentEnv.PLAINID_CLIENT_SECRET) {
    serviceDebug.set(`${component.name}:clientSecret`, Boolean(componentEnv.PLAINID_CLIENT_SECRET))
  } else {
    serviceDebug.set(`${component.name}:clientSecret`, false)
  }

  const template = readFileSync(component.template, 'utf8')
  const renderEnv = { ...process.env, ...componentEnv }
  const rendered = renderTemplate(template, renderEnv)

  for (const requiredVar of requiredTemplateVars) {
    const token = new RegExp(`\$\{${requiredVar}\}|\$${requiredVar}`)
    if (token.test(template) && !renderEnv[requiredVar]) {
      console.error(`Template substitution failed for ${component.name}: missing ${requiredVar}`)
      process.exit(1)
    }
  }

  const rel = relative(resolve(process.cwd(), 'edge/docker-compose/config'), component.template)
  const outputPath = resolve(generatedDir, rel)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${rendered}\n`, 'utf8')
}

const missing = requiredEnvVars.filter((name) => !mergedEnv[name])
if (missing.length > 0) {
  console.error('Missing required env vars for edge startup:', missing.join(', '))
  process.exit(1)
}

console.log('compose-edge: mcp-gateway .env has clientId:', serviceDebug.get('mcp-gateway:clientId'))
console.log('compose-edge: mcp-gateway .env has clientSecret:', serviceDebug.get('mcp-gateway:clientSecret'))
console.log('compose-edge: discovery-agent .env has clientId:', serviceDebug.get('discovery-agent:clientId'))
console.log('compose-edge: discovery-agent .env has clientSecret:', serviceDebug.get('discovery-agent:clientSecret'))

if (!mergedEnv.PLAINID_MCP_GATEWAY_HOST_PORT) {
  mergedEnv.PLAINID_MCP_GATEWAY_HOST_PORT = '5235'
}

const command = ['compose', '-p', 'plainid-edge', '-f', composeFile, ...process.argv.slice(2)]
const result = spawnSync('docker', command, {
  cwd: process.cwd(),
  env: mergedEnv,
  stdio: 'inherit',
  shell: false,
})

if (result.error) {
  throw result.error
}

if (typeof result.status === 'number' && result.status !== 0) {
  process.exit(result.status)
}
