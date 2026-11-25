// Copied to an isolated directory as "app-server" and launched with Node.
const { createInterface } = require('node:readline')
const { dirname, join } = require('node:path')
const { existsSync, writeFileSync, rmSync } = require('node:fs')
const assert = require('node:assert/strict')

const home = process.env.CODEX_HOME
const data = dirname(home)
const account = join(home, 'synthetic-account')
const loginId = '00000000-0000-4000-8000-000000000001'
const foreignId = '00000000-0000-4000-8000-000000000002'
const secret = 'fixture-sensitive-marker'
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const complete = (loginId, success) => send({
  method: 'account/login/completed', params: { loginId, success, error: secret },
})
let polling
writeFileSync(join(data, 'account-pid'), String(process.pid))
process.stderr.write(secret + '\n')

const lines = createInterface({ input: process.stdin })
lines.on('close', () => clearInterval(polling))
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line)
  const response = result => send({ id, result })
  const error = () => send({ id, error: { code: -32603, message: secret } })
  switch (method) {
    case 'initialize':
      response({ userAgent: 'codex/1.2.0', codexHome: home })
      break
    case 'config/read':
      response({ config: { sqlite_home: home, log_dir: join(home, 'log') } })
      break
    case 'account/read':
      assert.equal(params.refreshToken, false)
      if (existsSync(join(data, 'account-read-error'))) return error()
      const readAccount = () => response({
        account: existsSync(account) ? { type: 'chatgpt', email: secret, accessToken: secret } : null,
        requiresOpenaiAuth: true,
        userId: secret,
      })
      if (existsSync(join(data, 'hold-account-read'))) {
        writeFileSync(join(data, 'account-read-started'), '')
        polling = setInterval(() => {
          if (existsSync(join(data, 'hold-account-read'))) return
          clearInterval(polling)
          readAccount()
        }, 20)
      } else readAccount()
      break
    case 'account/login/start': {
      assert.deepEqual(params, { type: 'chatgptDeviceCode' })
      const invalid = existsSync(join(data, 'invalid-challenge'))
      response({
        type: 'chatgptDeviceCode',
        loginId,
        verificationUrl: invalid ? 'https://auth.openai.com@other.example/codex/device?' + secret
          : 'https://auth.openai.com/codex/device',
        userCode: 'TEST-1234',
        deviceAuthId: secret,
      })
      complete(foreignId, true)
      polling = setInterval(() => {
        if (!existsSync(join(data, 'complete-login'))) return
        clearInterval(polling)
        writeFileSync(account, secret)
        complete(loginId, true)
      }, 20)
      break
    }
    case 'account/login/cancel':
      assert.deepEqual(params, { loginId })
      clearInterval(polling)
      response({ status: 'canceled' })
      complete(loginId, false)
      break
    case 'account/logout':
      rmSync(account, { force: true })
      response({})
      break
  }
})
