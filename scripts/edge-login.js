const { config } = require('dotenv')
const { resolve } = require('path')
const { spawnSync } = require('child_process')

config({ path: resolve(process.cwd(), 'backend/.env') })

const host = process.env.PLAINID_DOCKER_REGISTRY_HOST
const username = process.env.PLAINID_DOCKER_REGISTRY_USERNAME
const password = process.env.PLAINID_DOCKER_REGISTRY_PASSWORD

if (!host || !username || !password) {
  console.error('Missing environment variable: PLAINID_DOCKER_REGISTRY_HOST, PLAINID_DOCKER_REGISTRY_USERNAME, and PLAINID_DOCKER_REGISTRY_PASSWORD are required in backend/.env')
  process.exit(1)
}

const result = spawnSync('docker', ['login', host, '-u', username, '--password-stdin'], {
  input: password,
  encoding: 'utf8',
})

if (result.error) {
  throw result.error
}

process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')

if (result.status !== 0) {
  process.exit(result.status)
}
