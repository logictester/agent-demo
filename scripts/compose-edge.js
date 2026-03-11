const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, relative, resolve } = require('path')
const { spawnSync } = require('child_process')
const { parse } = require('dotenv')

const composeFile = resolve(process.cwd(), 'edge/docker-compose/docker-compose.yaml')
const generatedDir = resolve(process.cwd(), 'edge/docker-compose/config/.generated')

const envFiles = [
  resolve(process.cwd(), 'edge/docker-compose/config/mcp-gateway/.env'),
  resolve(process.cwd(), 'edge/docker-compose/config/discovery-agent/.env'),
]

const configTemplates = [
  resolve(process.cwd(), 'edge/docker-compose/config/mcp-gateway/config.yaml'),
  resolve(process.cwd(), 'edge/docker-compose/config/discovery-agent/config.yaml'),
]

const mergedEnv = { ...process.env }
for (const path of envFiles) {
  if (!existsSync(path)) {
    continue
  }

  const parsed = parse(readFileSync(path))
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== '') {
      mergedEnv[key] = value
    }
  }
}

function renderTemplate(text) {
  const expanded = text.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (_, varNameCurly, varNamePlain) => {
    const key = varNameCurly || varNamePlain
    const value = mergedEnv[key]
    if (value === undefined) {
      return ''
    }
    return value
  })

  return expanded
}

for (const templatePath of configTemplates) {
  if (!existsSync(templatePath)) {
    continue
  }

  const template = readFileSync(templatePath, 'utf8')
  const rendered = renderTemplate(template)
  const rel = relative(resolve(process.cwd(), 'edge/docker-compose/config'), templatePath)
  const outputPath = resolve(generatedDir, rel)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${rendered}\n`, 'utf8')
}

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

const missing = requiredEnvVars.filter((name) => !mergedEnv[name])
if (missing.length > 0) {
  console.error('Missing required env vars for edge startup:', missing.join(', '))
  process.exit(1)
}

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
