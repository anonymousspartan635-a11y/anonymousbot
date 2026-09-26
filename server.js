import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import makeWASocket, { 
  useMultiFileAuthState, 
  downloadMediaMessage, 
  fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys'
import P from 'pino'
import axios from 'axios'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const activeSessions = new Map()
const badWordsList = ['fuck', 'bitch', 'asshole', 'bastard', 'shit', 'cunt', 'dick']

// Global Default Settings
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
  
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }))

  const makeSocket = makeWASocket.default || makeWASocket
  const sock = makeSocket({
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
      if (global.alwaysOnline) await sock.sendPresenceUpdate('available').catch(() => {})
    }
    if (u.connection === 'close') {
      const statusCode = u.lastDisconnect?.error?.output?.statusCode
      if (statusCode !== 401) {
        socketEmitter.emit('statusUpdate', { sessionId, status: 'RECONNECTING' })
        setTimeout(() => startUserBot(sessionId, phoneNumber, socketEmitter), 5000)
      } else {
        socketEmitter.emit('statusUpdate', { sessionId, status: 'LOGGED_OUT' })
        try { fs.rmSync(authFolder, { recursive: true, force: true }) } catch (e) {}
        activeSessions.delete(sessionId)
      }
    }
  })

  // Anti-Call Handler
  sock.ev.on('call', async (calls) => {
    if (!global.antiCall) return
    for (let call of calls) {
      if (call.status === 'offer') {
        try {
          await sock.rejectCall(call.id, call.from)
          await sock.sendMessage(call.from, { text: '⚠️ *Anti-Call Active:* Calls are automatically rejected.' })
        } catch (e) {}
      }
    }
  })

  // Settings Menu Helper
  async function sendSettingsMenu(jid) {
    awaitingSettingsReply.add(jid)
    const textMenu = `╭───「 *ANONYMOUS BOT* 」───
│ ⚙️ *BOT SETTINGS*
│ Reply with a dot command (.1 to .13) or text command:
│
│ ✯ .1 Auto Status View [${global.autoStatus ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .2 MSG Type [${global.msgType}]
│ ✯ .3 Anti View Once [${global.antiViewOnce ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .4 Auto Sticker [${global.autoSticker ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .5 Auto Reply [${global.autoReply ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .6 Anti Bad Words [${global.antiBadWords ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .7 Anti Link [${global.antiLink ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .8 Anti Call [${global.antiCall ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .9 Anti Delete [${global.antiDelete ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .10 Always Online [${global.alwaysOnline ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .11 Read Commands [${global.readCommands ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .12 Auto Typing [${global.autoTyping ? 'ON ✅' : 'OFF ❌'}]
│ ✯ .13 Auto Recording [${global.autoRecording ? 'ON ✅' : 'OFF ❌'}]
╰───────────────────
💬 *Send .1 through .13 or use direct commands (e.g. .autoreply off)*`

    await sock.sendMessage(jid, { text: textMenu }).catch(() => {})
  }

  // Song Downloader Helper
  async function downloadSongByName(songQuery, jid) {
    await sock.sendMessage(jid, { text: `🎵 Searching and downloading: *${songQuery}*...` }).catch(() => {})
    try {
      let res = await axios.get(`https://api.vreden.my.id/api/ytplay?query=${encodeURIComponent(songQuery)}`)
      let audioUrl = res.data?.result?.download?.url || res.data?.result?.url || res.data?.result?.dl_url
      let title = res.data?.result?.title || songQuery

      if (audioUrl) {
        await sock.sendMessage(jid, { audio: { url: audioUrl }, mimetype: 'audio/mpeg', fileName: `${title}.mp3` })
        return
      }
    } catch (e) {}

    await sock.sendMessage(jid, { text: `❌ Could not download song. Please check the song name or try again.` }).catch(() => {})
  }

  // Primary Messages Handler
  sock.ev.on('messages.upsert', async m => {
    try {
      const msg = m.messages[0]
      if (!msg || !msg.message) return

      const jid = msg.key.remoteJid
      const sender = msg.key.participant || jid

      if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) {
        if (global.autoStatus) await sock.readMessages([msg.key]).catch(() => {})
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

      if (!text) return

      if (global.readCommands && !msg.key.fromMe) await sock.readMessages([msg.key]).catch(() => {})

      if (!msg.key.fromMe) {
        if (global.autoTyping) await sock.sendPresenceUpdate('composing', jid).catch(() => {})
        else if (global.autoRecording) await sock.sendPresenceUpdate('recording', jid).catch(() => {})
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
          await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]}, bad words are not allowed!`, mentions: [sender] }).catch(() => {})
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

      const cmd = text.toLowerCase().trim()

      // Command: Open Settings
      if (cmd === '.settings' || cmd === '.botsettings' || cmd === '.menu') {
        await sendSettingsMenu(jid)
        return
      }

      // Direct Text Commands with Feedback
      if (cmd.startsWith('.autoreply')) {
        if (cmd.includes('on')) global.autoReply = true
        else if (cmd.includes('off')) global.autoReply = false
        else global.autoReply = !global.autoReply
        await sock.sendMessage(jid, { text: `🤖 Auto Reply is now: *${global.autoReply ? 'ON ✅' : 'OFF ❌'}*` }).catch(() => {})
        return
      }

      if (cmd.startsWith('.autostatus')) {
        if (cmd.includes('on')) global.autoStatus = true
        else if (cmd.includes('off')) global.autoStatus = false
        else global.autoStatus = !global.autoStatus
        await sock.sendMessage(jid, { text: `👁️ Auto Status View is now: *${global.autoStatus ? 'ON ✅' : 'OFF ❌'}*` }).catch(() => {})
        return
      }

      if (cmd.startsWith('.antiviewonce')) {
        if (cmd.includes('on')) global.antiViewOnce = true
        else if (cmd.includes('off')) global.antiViewOnce = false
        else global.antiViewOnce = !global.antiViewOnce
        await sock.sendMessage(jid, { text: `👁️ Anti View Once is now: *${global.antiViewOnce ? 'ON ✅' : 'OFF ❌'}*` }).catch(() => {})
        return
      }

      if (cmd.startsWith('.anticall')) {
        if (cmd.includes('on')) global.antiCall = true
        else if (cmd.includes('off')) global.antiCall = false
        else global.antiCall = !global.antiCall
        await sock.sendMessage(jid, { text: `📞 Anti Call is now: *${global.antiCall ? 'ON ✅' : 'OFF ❌'}*` }).catch(() => {})
        return
      }

      if (cmd.startsWith('.antilink')) {
        if (cmd.includes('on')) global.antiLink = true
        else if (cmd.includes('off')) global.antiLink = false
        else global.antiLink = !global.antiLink
        await sock.sendMessage(jid, { text: `🔗 Anti Link is now: *${global.antiLink ? 'ON ✅' : 'OFF ❌'}*` }).catch(() => {})
        return
      }

      if (cmd.startsWith('.antidelete')) {
        if (cmd.includes('on')) global.antiDelete = true
        else if (cmd.includes('off')) global.antiDelete = false
        else global.antiDelete = !global.antiDelete
        await sock.sendMessage(jid, { text: `🗑️ Anti Delete is now: *${global.antiDelete ? 'ON ✅' : 'OFF ❌'}*` }).catch(() => {})
        return
      }

      if (cmd.startsWith('.alwaysonline')) {
        if (cmd.includes('on')) global.alwaysOnline = true
        else if (cmd.includes('off')) global.alwaysOnline = false
        else global.alwaysOnline = !global.alwaysOnline
        await sock.sendMessage(jid, { text: `🟢 Always Online is now: *${global.alwaysOnline ? 'ON ✅' : 'OFF ❌'}*` }).catch(() => {})
        return
      }

      // Menu Toggle Options (.1 to .13) or Number Replies
      const isDotSwitch = ['.1', '.2', '.3', '.4', '.5', '.6', '.7', '.8', '.9', '.10', '.11', '.12', '.13'].includes(cmd)
      const isNumSwitch = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'].includes(cmd)

      if (isDotSwitch || (awaitingSettingsReply.has(jid) && isNumSwitch)) {
        let option = cmd.replace('.', '')
        let replyMsg = ''

        switch (option) {
          case '1': global.autoStatus = !global.autoStatus; replyMsg = `👁️ Auto Status View is now: *${global.autoStatus ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '2': global.msgType = global.msgType === 'text' ? 'button' : 'text'; replyMsg = `💬 MSG Type set to: *${global.msgType}*`; break;
          case '3': global.antiViewOnce = !global.antiViewOnce; replyMsg = `👁️ Anti View Once is now: *${global.antiViewOnce ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '4': global.autoSticker = !global.autoSticker; replyMsg = `🖼️ Auto Sticker is now: *${global.autoSticker ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '5': global.autoReply = !global.autoReply; replyMsg = `🤖 Auto Reply is now: *${global.autoReply ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '6': global.antiBadWords = !global.antiBadWords; replyMsg = `⚠️ Anti Bad Words is now: *${global.antiBadWords ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '7': global.antiLink = !global.antiLink; replyMsg = `🔗 Anti Link is now: *${global.antiLink ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '8': global.antiCall = !global.antiCall; replyMsg = `📞 Anti Call is now: *${global.antiCall ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '9': global.antiDelete = !global.antiDelete; replyMsg = `🗑️ Anti Delete is now: *${global.antiDelete ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '10': global.alwaysOnline = !global.alwaysOnline; replyMsg = `🟢 Always Online is now: *${global.alwaysOnline ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '11': global.readCommands = !global.readCommands; replyMsg = `✓✓ Read Commands is now: *${global.readCommands ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '12': global.autoTyping = !global.autoTyping; replyMsg = `✍️ Auto Typing is now: *${global.autoTyping ? 'ON ✅' : 'OFF ❌'}*`; break;
          case '13': global.autoRecording = !global.autoRecording; replyMsg = `🎙️ Auto Recording is now: *${global.autoRecording ? 'ON ✅' : 'OFF ❌'}*`; break;
        }

        awaitingSettingsReply.delete(jid)
        await sock.sendMessage(jid, { text: replyMsg }).catch(() => {})
        return
      }

      // Command: Alive Status
      if (cmd === '.alive') {
        await sock.sendMessage(jid, { text: 'ANONYMOUS BOT is Active ✅' }).catch(() => {})
        return
      }

      // Command: Song Downloader
      if (cmd.startsWith('.song') || cmd.startsWith('.play') || cmd.startsWith('.music')) {
        let songName = text.replace(/^\.(song|play|music)/i, '').trim()
        if (!songName) {
          await sock.sendMessage(jid, { text: '⚠️ Please provide a song name.\n*Example:* `.song Drake Hotline Bling`' }).catch(() => {})
          return
        }
        await downloadSongByName(songName, jid)
        return
      }
    } catch (err) {
      console.error('Error in message event:', err)
    }
  })

  // Anti-Delete Handler
  sock.ev.on('messages.update', async updates => {
    if (!global.antiDelete) return
    for (let up of updates) {
      if (up.update.message === null) {
        let stored = msgStore[up.key.remoteJid]?.[up.key.id]
        if (stored) {
          let content = stored.message?.conversation || stored.message?.extendedTextMessage?.text || '[Media Deleted]'
          await sock.sendMessage(up.key.remoteJid, { text: `🚫 *Anti-Delete Triggered*\nMessage content: ${content}` }).catch(() => {})
        }
      }
    }
  })
}

// Global Process Crash Guards
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

// REST API endpoint
app.post('/api/deploy', (req, res) => {
  const { phoneNumber } = req.body
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' })

  const sessionsDir = path.join(__dirname, 'sessions')
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true })
  }

  const sessionId = 'user_' + Date.now()
  startUserBot(sessionId, phoneNumber, io)

  return res.json({ success: true, sessionId })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`🚀 ANONYMOUS BOT running on http://localhost:${PORT}`))
