const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const path = require('path')
const fs = require('fs')
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  downloadMediaMessage, 
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys')
const P = require('pino')
const axios = require('axios')

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const activeSessions = new Map()
const badWordsList = ['fuck', 'bitch', 'asshole', 'bastard', 'shit', 'cunt', 'dick']

// Global Default Switches
global.autoStatus = true
global.msgType = 'text'
global.antiViewOnce = true
global.autoSticker = false
global.autoReply = true
global.antiBadWords = false
global.antiLink = true
global.antiCall = true
global.antiDelete = true
global.alwaysOnline = true
global.readCommands = true
global.autoTyping = false
global.autoRecording = false

const msgStore = {}
const awaitingSettingsReply = new Set()

async function startUserBot(sessionId, phoneNumber, socketEmitter) {
  const authFolder = path.join(__dirname, 'sessions', sessionId)
  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    printQRInTerminal: false
  })

  activeSessions.set(sessionId, sock)
  sock.ev.on('creds.update', saveCreds)

  if (!sock.authState.creds.registered && phoneNumber) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '')
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(cleanNumber)
        socketEmitter.emit('pairingCode', { sessionId, code })
      } catch (e) {
        socketEmitter.emit('botError', { sessionId, message: 'Failed to generate code: ' + e.message })
      }
    }, 3000)
  }

  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open') {
      socketEmitter.emit('statusUpdate', { sessionId, status: 'CONNECTED' })
      if (global.alwaysOnline) await sock.sendPresenceUpdate('available')
    }
    if (u.connection === 'close') {
      const statusCode = u.lastDisconnect?.error?.output?.statusCode
      if (statusCode !== 401) {
        socketEmitter.emit('statusUpdate', { sessionId, status: 'RECONNECTING' })
        startUserBot(sessionId, phoneNumber, socketEmitter)
      } else {
        socketEmitter.emit('statusUpdate', { sessionId, status: 'LOGGED_OUT' })
        fs.rmSync(authFolder, { recursive: true, force: true })
        activeSessions.delete(sessionId)
      }
    }
  })

  // Anti-Call Listener
  sock.ev.on('call', async (calls) => {
    if (!global.antiCall) return
    for (let call of calls) {
      if (call.status === 'offer') {
        await sock.rejectCall(call.id, call.from)
        await sock.sendMessage(call.from, { text: '⚠️ *Anti-Call Active:* Calls are automatically rejected.' })
      }
    }
  })

  // Settings Menu Generator
  async function sendSettingsMenu(jid) {
    awaitingSettingsReply.add(jid)
    const textMenu = `╭───「 *ANONYMOUS BOT* 」───
│ ⚙️ *BOT SETTINGS*
│ Reply with a number to toggle:
│
│ ✯ 1. Auto Status View [${global.autoStatus ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 2. MSG Type [${global.msgType}]
│ ✯ 3. Anti View Once [${global.antiViewOnce ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 4. Auto Sticker [${global.autoSticker ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 5. Auto Reply [${global.autoReply ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 6. Anti Bad Words [${global.antiBadWords ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 7. Anti Link [${global.antiLink ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 8. Anti Call [${global.antiCall ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 9. Anti Delete [${global.antiDelete ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 10. Always Online [${global.alwaysOnline ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 11. Read Commands [${global.readCommands ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 12. Auto Typing [${global.autoTyping ? 'ON ✅' : 'OFF ❌'}]
│ ✯ 13. Auto Recording [${global.autoRecording ? 'ON ✅' : 'OFF ❌'}]
╰───────────────────
💬 *Reply with a number (1-13)*`

    await sock.sendMessage(jid, { text: textMenu })
  }

  // Song Downloader Helper
  async function downloadSongByName(songQuery, jid) {
    await sock.sendMessage(jid, { text: `🎵 Searching and downloading: *${songQuery}*...` })
    try {
      let res = await axios.get(`https://api.vreden.my.id/api/ytplay?query=${encodeURIComponent(songQuery)}`)
      let audioUrl = res.data?.result?.download?.url || res.data?.result?.url || res.data?.result?.dl_url
      let title = res.data?.result?.title || songQuery

      if (audioUrl) {
        await sock.sendMessage(jid, { audio: { url: audioUrl }, mimetype: 'audio/mpeg', fileName: `${title}.mp3` })
        return
      }
    } catch (e) {}

    await sock.sendMessage(jid, { text: `❌ Could not download song. Please check the song name or try again.` })
  }

  // Primary Messages Handler
  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages[0]
    if (!msg || !msg.message) return

    const jid = msg.key.remoteJid
    const sender = msg.key.participant || jid

    if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) {
      try {
        if (global.autoStatus) await sock.readMessages([msg.key])
      } catch (e) {}
      return
    }

    if (!msgStore[jid]) msgStore[jid] = {}
    msgStore[jid][msg.key.id] = msg

    const text = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      ""
    ).trim()

    if (global.readCommands && !msg.key.fromMe) await sock.readMessages([msg.key])

    if (!msg.key.fromMe) {
      if (global.autoTyping) await sock.sendPresenceUpdate('composing', jid)
      else if (global.autoRecording) await sock.sendPresenceUpdate('recording', jid)
    }

    if (global.antiViewOnce) {
      const viewOnce = msg.message.viewOnceMessageV2?.message || msg.message.viewOnceMessage?.message
      if (viewOnce) {
        try {
          const type = Object.keys(viewOnce)[0]
          const buffer = await downloadMediaMessage({ message: viewOnce }, 'buffer', {}, { logger: P({ level: 'silent' }) })
          let cap = `*👁️ Anti-ViewOnce Triggered* from @${sender.split('@')[0]}`
          if (type === 'imageMessage') await sock.sendMessage(jid, { image: buffer, caption: cap, mentions: [sender] })
          if (type === 'videoMessage') await sock.sendMessage(jid, { video: buffer, caption: cap, mentions: [sender] })
        } catch (e) {}
      }
    }

    if (global.antiBadWords && !msg.key.fromMe) {
      const lowerText = text.toLowerCase()
      if (badWordsList.some(word => lowerText.includes(word))) {
        await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]}, bad words are not allowed!`, mentions: [sender] })
        return
      }
    }

    if (global.antiLink && jid.endsWith('@g.us') && text.includes('https://chat.whatsapp.com/')) {
      try {
        const meta = await sock.groupMetadata(jid)
        const isAdmin = meta.participants.find(p => p.id === sender)?.admin
        const botAdmin = meta.participants.find(p => p.id === sock.user.id)?.admin
        if (!isAdmin && botAdmin) {
          await sock.sendMessage(jid, { text: `🚫 Anti-Link triggered for @${sender.split('@')[0]}`, mentions: [sender] })
          await sock.groupParticipantsUpdate(jid, [sender], 'remove')
          return
        }
      } catch (e) {}
    }

    const cmd = text.toLowerCase()

    // Command: Open Settings
    if (cmd === '.settings' || cmd === '.botsettings') {
      await sendSettingsMenu(jid)
      return
    }

    // Toggle Settings Options by replying with a number
    if (awaitingSettingsReply.has(jid) && ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'].includes(cmd)) {
      let replyMsg = ''
      switch (cmd) {
        case '1': global.autoStatus = !global.autoStatus; replyMsg = `Auto Status View is now: ${global.autoStatus ? 'ON ✅' : 'OFF ❌'}`; break;
        case '2': global.msgType = global.msgType === 'text' ? 'button' : 'text'; replyMsg = `MSG Type set to: ${global.msgType}`; break;
        case '3': global.antiViewOnce = !global.antiViewOnce; replyMsg = `Anti View Once is now: ${global.antiViewOnce ? 'ON ✅' : 'OFF ❌'}`; break;
        case '4': global.autoSticker = !global.autoSticker; replyMsg = `Auto Sticker is now: ${global.autoSticker ? 'ON ✅' : 'OFF ❌'}`; break;
        case '5': global.autoReply = !global.autoReply; replyMsg = `Auto Reply is now: ${global.autoReply ? 'ON ✅' : 'OFF ❌'}`; break;
        case '6': global.antiBadWords = !global.antiBadWords; replyMsg = `Anti Bad Words is now: ${global.antiBadWords ? 'ON ✅' : 'OFF ❌'}`; break;
        case '7': global.antiLink = !global.antiLink; replyMsg = `Anti Link is now: ${global.antiLink ? 'ON ✅' : 'OFF ❌'}`; break;
        case '8': global.antiCall = !global.antiCall; replyMsg = `Anti Call is now: ${global.antiCall ? 'ON ✅' : 'OFF ❌'}`; break;
        case '9': global.antiDelete = !global.antiDelete; replyMsg = `Anti Delete is now: ${global.antiDelete ? 'ON ✅' : 'OFF ❌'}`; break;
        case '10': global.alwaysOnline = !global.alwaysOnline; replyMsg = `Always Online is now: ${global.alwaysOnline ? 'ON ✅' : 'OFF ❌'}`; break;
        case '11': global.readCommands = !global.readCommands; replyMsg = `Read Commands is now: ${global.readCommands ? 'ON ✅' : 'OFF ❌'}`; break;
        case '12': global.autoTyping = !global.autoTyping; replyMsg = `Auto Typing is now: ${global.autoTyping ? 'ON ✅' : 'OFF ❌'}`; break;
        case '13': global.autoRecording = !global.autoRecording; replyMsg = `Auto Recording is now: ${global.autoRecording ? 'ON ✅' : 'OFF ❌'}`; break;
      }
      awaitingSettingsReply.delete(jid)
      await sock.sendMessage(jid, { text: replyMsg })
      return
    }

    // Command: Alive Status
    if (cmd === '.alive') {
      await sock.sendMessage(jid, { text: 'ANONYMOUS BOT is Active ✅' })
      return
    }

    // Command: Song Downloader
    if (cmd.startsWith('.song ') || cmd.startsWith('.play ') || cmd.startsWith('.music ')) {
      let songName = text.slice(text.indexOf(' ') + 1).trim()
      if (!songName) return sock.sendMessage(jid, { text: 'Usage: .song <music name>' })
      await downloadSongByName(songName, jid)
      return
    }
  })

  // Anti-Delete Listener
  sock.ev.on('messages.update', async updates => {
    if (!global.antiDelete) return
    for (let up of updates) {
      if (up.update.message === null) {
        let stored = msgStore[up.key.remoteJid]?.[up.key.id]
        if (stored) {
          let content = stored.message?.conversation || stored.message?.extendedTextMessage?.text || '[Media Deleted]'
          await sock.sendMessage(up.key.remoteJid, { text: `🚫 *Anti-Delete Triggered*\nMessage content: ${content}` })
        }
      }
    }
  })
}

// REST API for Web deployment
app.post('/api/deploy', (req, res) => {
  const { phoneNumber } = req.body
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' })

  const sessionId = 'user_' + Date.now()
  startUserBot(sessionId, phoneNumber, io)

  return res.json({ success: true, sessionId })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`🚀 ANONYMOUS BOT Web Deployer running on http://localhost:${PORT}`))
