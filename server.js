import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import path from 'path'
import { fileURLToPath } from 'url'
import makeWASocket, { 
  downloadMediaMessage, 
  fetchLatestBaileysVersion, 
  initAuthCreds, 
  BufferJSON, 
  proto 
} from '@whiskeysockets/baileys'
import P from 'pino'
import axios from 'axios'
import yts from 'yt-search'
import { MongoClient } from 'mongodb'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const activeSessions = new Map()
const badWordsList = ['fuck', 'bitch', 'asshole', 'bastard', 'shit', 'cunt', 'dick']

// Reaction Emojis
const statusEmojis = [
  '❤️', '💖', '💘', '💝', '💗', '💓', '❣️', '💕', '💙', '💚', '💛', '💜', '🖤', '🤍', '🤎',
  '🔥', '⚡', '💯', '✨', '🌟', '💥', '🚀', '💣', '👑', '🏆',
  '👍', '👏', '🙌', '🫡', '🤝', '💪', '🥳', '🎉', '🎊',
  '😍', '🤩', '😎', '🥹', '😂', '🤣', '🤤', '🫠', '🙃', '🙈'
]

// Global Settings
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

// Dynamic Custom Auto-Reply Message
global.customAwayMsg = "ANONYMOUS SPARTAN 😈😎 is away, please just leave a message he will be back in a blink of an eye 👁"

const msgStore = {}
const awaitingSettingsReply = new Set()
const awaitingCustomReplyInput = new Set()
const awaitingSongFormatSelection = new Map()

// MongoDB Setup
const MONGO_URI = process.env.MONGO_URI
let mongoClient, db

async function initMongo() {
  if (!MONGO_URI) return null
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGO_URI)
    await mongoClient.connect()
    db = mongoClient.db('anonymousbot')
    console.log('✅ Connected to MongoDB Atlas Cluster0')
  }
  return db
}

// Custom MongoDB Authentication Handler
async function useMongoAuthState(sessionId) {
  const database = await initMongo()
  if (!database) throw new Error("MONGO_URI not configured")

  const collection = database.collection(`session_${sessionId}`)

  const writeData = async (data, id) => {
    try {
      await collection.updateOne(
        { _id: id },
        { $set: { data: JSON.stringify(data, BufferJSON.replacer) } },
        { upsert: true }
      )
    } catch (e) {
      console.error('Mongo write error:', e)
    }
  }

  const readData = async (id) => {
    try {
      const result = await collection.findOne({ _id: id })
      if (!result) return null
      return JSON.parse(result.data, BufferJSON.reviver)
    } catch (e) {
      return null
    }
  }

  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id })
    } catch (e) {}
  }

  const clearSession = async () => {
    try {
      await collection.drop()
      console.log(`🗑️ Successfully dropped session collection: session_${sessionId}`)
    } catch (e) {
      console.error('Error dropping session collection:', e)
    }
  }

  const creds = (await readData('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              data[id] = value
            })
          )
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const key = `${category}-${id}`
              tasks.push(value ? writeData(value, key) : removeData(key))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds'),
    clearSession
  }
}

async function startUserBot(sessionId, phoneNumber, socketEmitter) {
  let state, saveCreds, clearSession

  try {
    const mongoAuth = await useMongoAuthState(sessionId)
    state = mongoAuth.state
    saveCreds = mongoAuth.saveCreds
    clearSession = mongoAuth.clearSession
  } catch (err) {
    console.error('Failed to load MongoDB Session, check MONGO_URI variable.', err)
    return
  }

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
        activeSessions.delete(sessionId)
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
│
│ 🛠️ *UTILITY COMMANDS:*
│ ✯ .setreply - Change greeting response text
│ ✯ .del - Delete replied message
│ ✯ .block - Block user
│ ✯ .getdp - Save profile photo
│ ✯ .save - Save replied media/viewOnce
│ ✯ .getstat - Save replied status
│ ✯ .song <name> - Download songs
│ ✯ .unlink - Clear session & reset
│
│ 👥 *GROUP COMMANDS:*
│ ✯ .kick | .promote | .demote | .tagall
╰───────────────────`

    await sock.sendMessage(jid, { text: textMenu }).catch(() => {})
  }

  // Bulletproof YouTube Downloader Handler
  async function fetchSongDetails(songQuery, jid) {
    await sock.sendMessage(jid, { text: `🔎 Searching YouTube for: *${songQuery}*...` }).catch(() => {})

    let targetUrl = ''
    let title = songQuery

    // Step 1: Query YouTube via yt-search
    try {
      const searchResult = await yts(songQuery)
      const video = searchResult?.videos?.[0]
      if (video) {
        targetUrl = video.url
        title = video.title
      }
    } catch (err) {
      console.error('yt-search failed:', err.message)
    }

    if (!targetUrl) {
      targetUrl = songQuery
    }

    // Step 2: Query audio endpoints using direct video URL
    const apis = [
      {
        url: `https://api.vreden.my.id/api/ytmp3?url=${encodeURIComponent(targetUrl)}`,
        extract: (d) => d?.result?.download?.url || d?.result?.url
      },
      {
        url: `https://api.davidcyriltech.my.id/download/ytmp3?url=${encodeURIComponent(targetUrl)}`,
        extract: (d) => d?.result?.downloadUrl || d?.result?.url || d?.url
      },
      {
        url: `https://widipe.com/download/ytmp3?url=${encodeURIComponent(targetUrl)}`,
        extract: (d) => d?.result?.dl_url || d?.result?.mp3 || d?.dl_url
      },
      {
        url: `https://api.cobalt.tools/api/json`,
        method: 'POST',
        data: { url: targetUrl, audioFormat: 'mp3', isAudioOnly: true },
        extract: (d) => d?.url
      }
    ]

    for (const api of apis) {
      try {
        let res
        if (api.method === 'POST') {
          res = await axios.post(api.url, api.data, {
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            timeout: 15000
          })
        } else {
          res = await axios.get(api.url, { timeout: 15000 })
        }

        const audioUrl = api.extract(res.data)

        if (audioUrl) {
          const menuText = `🎶 *${title}*\n\nSelect delivery format by replying with the number:\n\n1️⃣ Audio File (.mp3)\n2️⃣ Document File (.doc/.mp3)\n3️⃣ Voice Message (PTT)`
          
          const promptMsg = await sock.sendMessage(jid, { text: menuText }).catch(() => {})

          if (promptMsg?.key?.id) {
            awaitingSongFormatSelection.set(promptMsg.key.id, {
              audioUrl,
              title
            })
          }
          return
        }
      } catch (e) {
        console.error(`Download API failed: ${api.url}`, e.message)
      }
    }

    await sock.sendMessage(jid, { text: `❌ All audio download servers are currently offline or busy. Please try again shortly.` }).catch(() => {})
  }

  // Helper to extract user target from mentions or replies
  function getTargetJid(msg) {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
    if (contextInfo?.mentionedJid?.length > 0) return contextInfo.mentionedJid[0]
    if (contextInfo?.participant) return contextInfo.participant
    return null
  }

  // Anti-Call
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

  // Messages Handler
  sock.ev.on('messages.upsert', async m => {
    try {
      const msg = m.messages[0]
      if (!msg || !msg.message) return

      const jid = msg.key.remoteJid
      const sender = msg.key.participant || jid

      // Status View & Auto Reaction
      if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) {
        if (global.autoStatus) {
          await sock.readMessages([msg.key]).catch(() => {})
          try {
            const randomEmoji = statusEmojis[Math.floor(Math.random() * statusEmojis.length)]
            await sock.sendMessage(
              'status@broadcast',
              { react: { text: randomEmoji, key: msg.key } },
              { statusJidList: [msg.key.participant] }
            )
          } catch (e) {}
        }
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

      if (!text && !msg.message.viewOnceMessageV2 && !msg.message.viewOnceMessage) return

      if (global.readCommands && !msg.key.fromMe) await sock.readMessages([msg.key]).catch(() => {})

      if (!msg.key.fromMe) {
        if (global.autoTyping) await sock.sendPresenceUpdate('composing', jid).catch(() => {})
        else if (global.autoRecording) await sock.sendPresenceUpdate('recording', jid).catch(() => {})
      }

      // Check if user is replying to song format selection
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo
      const quotedId = contextInfo?.stanzaId

      if (quotedId && awaitingSongFormatSelection.has(quotedId)) {
        const songData = awaitingSongFormatSelection.get(quotedId)
        const choice = text.trim()

        if (['1', '2', '3'].includes(choice)) {
          awaitingSongFormatSelection.delete(quotedId)
          await sock.sendMessage(jid, { text: `⏳ Sending *${songData.title}*...` }).catch(() => {})

          try {
            if (choice === '1') {
              // Standard Audio File
              await sock.sendMessage(jid, {
                audio: { url: songData.audioUrl },
                mimetype: 'audio/mpeg',
                fileName: `${songData.title}.mp3`
              })
            } else if (choice === '2') {
              // Document File
              await sock.sendMessage(jid, {
                document: { url: songData.audioUrl },
                mimetype: 'audio/mpeg',
                fileName: `${songData.title}.mp3`
              })
            } else if (choice === '3') {
              // Voice Message (PTT)
              await sock.sendMessage(jid, {
                audio: { url: songData.audioUrl },
                mimetype: 'audio/mp4',
                ptt: true
              })
            }
          } catch (err) {
            await sock.sendMessage(jid, { text: '❌ Failed to send audio file.' }).catch(() => {})
          }
          return
        }
      }

      // Check if user is replying with custom message text for .setreply
      if (awaitingCustomReplyInput.has(jid) && msg.key.fromMe) {
        global.customAwayMsg = text
        awaitingCustomReplyInput.delete(jid)
        await sock.sendMessage(jid, { text: `✅ Custom greeting auto-reply set to:\n\n"${global.customAwayMsg}"` }).catch(() => {})
        return
      }

      // Silent Anti-ViewOnce
      if (global.antiViewOnce) {
        const viewOnce = msg.message?.viewOnceMessageV2?.message || msg.message?.viewOnceMessage?.message
        if (viewOnce) {
          try {
            const type = Object.keys(viewOnce)[0]
            const buffer = await downloadMediaMessage({ message: viewOnce }, 'buffer', {}, { logger: P({ level: 'silent' }) })
            
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net'
            const senderName = `@${sender.split('@')[0]}`
            const chatLocation = jid.endsWith('@g.us') ? 'a group chat' : 'direct messages'
            
            let cap = `👁️ *Anti-ViewOnce Saved*\n\n*From:* ${senderName}\n*Location:* Sent in ${chatLocation}`
            
            if (type === 'imageMessage') {
              await sock.sendMessage(myJid, { image: buffer, caption: cap, mentions: [sender] })
            } else if (type === 'videoMessage') {
              await sock.sendMessage(myJid, { video: buffer, caption: cap, mentions: [sender] })
            }
          } catch (e) {
            console.error('Error handling ViewOnce media:', e)
          }
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

      // Command: .setreply
      if (cmd === '.setreply' || cmd.startsWith('.setreply ')) {
        const inlineText = text.substring(9).trim()
        if (inlineText) {
          global.customAwayMsg = inlineText
          await sock.sendMessage(jid, { text: `✅ Custom auto-reply message set to:\n\n"${global.customAwayMsg}"` }).catch(() => {})
        } else {
          awaitingCustomReplyInput.add(jid)
          await sock.sendMessage(jid, { text: `💬 *What do you want me to say when you are texted hello, hi, wassup, etc.?*\n\nPlease reply with your custom message now:` }).catch(() => {})
        }
        return
      }

      // Custom Auto-Reply to Greetings
      if (global.autoReply && !msg.key.fromMe) {
        const greetingTriggers = ['hi', 'hello', 'yo', 'wassup', 'sup', 'bro', 'boi', 'hey']
        
        if (greetingTriggers.includes(cmd)) {
          await sock.sendMessage(jid, { text: global.customAwayMsg }).catch(() => {})
          return
        }
      }

      // Command: .del / .delete
      if (cmd === '.del' || cmd === '.delete') {
        const quotedKey = contextInfo?.stanzaId

        if (!quotedKey) {
          await sock.sendMessage(jid, { text: '⚠️ Please reply directly to the message you want to delete using `.del`' }).catch(() => {})
          return
        }

        const isGroup = jid.endsWith('@g.us')
        const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net'
        
        let quotedSender
        if (isGroup) {
          quotedSender = contextInfo?.participant
        } else {
          quotedSender = contextInfo?.participant || (msg.key.fromMe ? myJid : jid)
        }

        const isMyOwnMessage = quotedSender ? (quotedSender.split('@')[0] === sock.user.id.split(':')[0]) : false

        if (isGroup && !isMyOwnMessage) {
          try {
            const meta = await sock.groupMetadata(jid)
            const botAdmin = meta.participants.find(p => p.id === myJid)?.admin
            if (!botAdmin) {
              await sock.sendMessage(jid, { text: '❌ I need to be a **Group Admin** to delete messages sent by other members.' }).catch(() => {})
              return
            }
          } catch (e) {}
        } else if (!isGroup && !isMyOwnMessage) {
          await sock.sendMessage(jid, { text: '❌ WhatsApp rules do not allow deleting someone else\'s message in direct messages (DMs).' }).catch(() => {})
          return
        }

        const deleteKey = {
          remoteJid: jid,
          fromMe: isMyOwnMessage,
          id: quotedKey,
          participant: isGroup ? quotedSender : undefined
        }

        try {
          await sock.sendMessage(jid, { delete: deleteKey })
          await sock.sendMessage(jid, { delete: msg.key }).catch(() => {})
        } catch (e) {
          console.error('Delete error:', e)
          await sock.sendMessage(jid, { text: '❌ Failed to delete message.' }).catch(() => {})
        }
        return
      }

      // Command: .block
      if (cmd.startsWith('.block')) {
        let target = getTargetJid(msg) || jid

        if (target.endsWith('@g.us')) {
          await sock.sendMessage(jid, { text: '⚠️ In a group chat, please reply to or tag the user you want to block: `.block @user`' }).catch(() => {})
          return
        }

        const cleanJid = target.split('@')[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net'

        try {
          await sock.sendMessage(jid, { text: `🚫 Blocking @${cleanJid.split('@')[0]}...`, mentions: [cleanJid] })
          await sock.updateBlockStatus(cleanJid, 'block')
        } catch (e) {
          console.error('Block error:', e)
          await sock.sendMessage(jid, { text: '❌ Failed to block user: ' + (e.message || e) }).catch(() => {})
        }
        return
      }

      // Command: .unlink
      if (cmd === '.unlink') {
        await sock.sendMessage(jid, { text: '🗑️ *Unlinking Session...*\nDeleting MongoDB Atlas credentials and logging out.' }).catch(() => {})
        
        try {
          await clearSession()
          activeSessions.delete(sessionId)
          await sock.logout().catch(() => {})
          sock.end(new Error('Session unlinked by user'))
          console.log(`✅ Session ${sessionId} cleared and socket disconnected.`)
        } catch (e) {
          console.error('Error during .unlink command execution:', e)
        }
        return
      }

      // Command: Open Settings
      if (cmd === '.settings' || cmd === '.botsettings' || cmd === '.menu') {
        await sendSettingsMenu(jid)
        return
      }

      // Direct Word Commands
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
        await sock.sendMessage(jid, { text: `👁️ Auto Status View & Reaction is now: *${global.autoStatus ? 'ON ✅' : 'OFF ❌'}*` }).catch(() => {})
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

      // Menu Toggle Options (.1 to .13)
      const isDotSwitch = ['.1', '.2', '.3', '.4', '.5', '.6', '.7', '.8', '.9', '.10', '.11', '.12', '.13'].includes(cmd)
      const isNumSwitch = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'].includes(cmd)

      if (isDotSwitch || (awaitingSettingsReply.has(jid) && isNumSwitch)) {
        let option = cmd.replace('.', '')
        let replyMsg = ''

        switch (option) {
          case '1': global.autoStatus = !global.autoStatus; replyMsg = `👁️ Auto Status View & Reaction is now: *${global.autoStatus ? 'ON ✅' : 'OFF ❌'}*`; break;
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

      // Command: .getdp
      if (cmd.startsWith('.getdp')) {
        let target = getTargetJid(msg) || sender
        try {
          let dpUrl = await sock.profilePictureUrl(target, 'image')
          await sock.sendMessage(jid, { image: { url: dpUrl }, caption: `🖼️ Profile picture of @${target.split('@')[0]}`, mentions: [target] })
        } catch (e) {
          await sock.sendMessage(jid, { text: '❌ Could not retrieve profile picture.' }).catch(() => {})
        }
        return
      }

      // Command: .save
      if (cmd === '.save') {
        const quotedMsg = contextInfo?.quotedMessage

        if (!quotedMsg) {
          await sock.sendMessage(jid, { text: '⚠️ Please reply to a media message or ViewOnce using `.save`' }).catch(() => {})
          return
        }

        try {
          const viewOnce = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessage?.message
          const mediaObj = viewOnce ? { message: viewOnce } : { message: quotedMsg }
          const type = Object.keys(mediaObj.message)[0]

          const buffer = await downloadMediaMessage(mediaObj, 'buffer', {}, { logger: P({ level: 'silent' }) })

          if (type.includes('image')) {
            await sock.sendMessage(jid, { image: buffer, caption: '✅ Media Saved' })
          } else if (type.includes('video')) {
            await sock.sendMessage(jid, { video: buffer, caption: '✅ Media Saved' })
          } else if (type.includes('audio')) {
            await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4' })
          } else if (type.includes('document')) {
            await sock.sendMessage(jid, { document: buffer, mimetype: 'application/octet-stream', fileName: 'saved_media' })
          } else {
            await sock.sendMessage(jid, { text: '❌ Unsupported media type.' })
          }
        } catch (e) {
          await sock.sendMessage(jid, { text: '❌ Failed to save media: ' + e.message })
        }
        return
      }

      // Command: .getstat
      if (cmd === '.getstat') {
        const quotedMsg = contextInfo?.quotedMessage

        if (!quotedMsg) {
          await sock.sendMessage(jid, { text: '⚠️ Please reply directly to a status update message using `.getstat`' }).catch(() => {})
          return
        }

        try {
          const buffer = await downloadMediaMessage({ message: quotedMsg }, 'buffer', {}, { logger: P({ level: 'silent' }) })
          const type = Object.keys(quotedMsg)[0]

          if (type.includes('image')) {
            await sock.sendMessage(jid, { image: buffer, caption: '📲 Status Downloaded' })
          } else if (type.includes('video')) {
            await sock.sendMessage(jid, { video: buffer, caption: '📲 Status Downloaded' })
          } else {
            await sock.sendMessage(jid, { text: `📲 Status Text:\n\n${quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || ''}` })
          }
        } catch (e) {
          await sock.sendMessage(jid, { text: '❌ Failed to download status: ' + e.message })
        }
        return
      }

      // Group Administration Commands
      if (jid.endsWith('@g.us')) {
        const meta = await sock.groupMetadata(jid).catch(() => null)
        const isBotAdmin = meta?.participants.find(p => p.id === sock.user.id.split(':')[0] + '@s.whatsapp.net')?.admin
        const isSenderAdmin = meta?.participants.find(p => p.id === sender)?.admin

        if (cmd.startsWith('.kick') || cmd.startsWith('.remove')) {
          if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Only group admins can use this command.' })
          if (!isBotAdmin) return sock.sendMessage(jid, { text: '❌ I need to be a Group Admin to kick members.' })

          let target = getTargetJid(msg)
          if (!target) return sock.sendMessage(jid, { text: '⚠️ Please tag or reply to the user you want to kick.' })

          await sock.groupParticipantsUpdate(jid, [target], 'remove')
          await sock.sendMessage(jid, { text: `🚪 Removed @${target.split('@')[0]} from the group.`, mentions: [target] })
          return
        }

        if (cmd.startsWith('.promote')) {
          if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Only group admins can promote members.' })
          if (!isBotAdmin) return sock.sendMessage(jid, { text: '❌ I need to be a Group Admin to promote members.' })

          let target = getTargetJid(msg)
          if (!target) return sock.sendMessage(jid, { text: '⚠️ Please tag or reply to the user you want to promote.' })

          await sock.groupParticipantsUpdate(jid, [target], 'promote')
          await sock.sendMessage(jid, { text: `👑 @${target.split('@')[0]} is now an Admin!`, mentions: [target] })
          return
        }

        if (cmd.startsWith('.demote')) {
          if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Only group admins can demote members.' })
          if (!isBotAdmin) return sock.sendMessage(jid, { text: '❌ I need to be a Group Admin to demote members.' })

          let target = getTargetJid(msg)
          if (!target) return sock.sendMessage(jid, { text: '⚠️ Please tag or reply to the user you want to demote.' })

          await sock.groupParticipantsUpdate(jid, [target], 'demote')
          await sock.sendMessage(jid, { text: `📉 @${target.split('@')[0]} has been demoted to a normal member.`, mentions: [target] })
          return
        }

        if (cmd.startsWith('.tagall') || cmd.startsWith('.everyone')) {
          if (!meta) return
          let participants = meta.participants.map(p => p.id)
          let announceText = `📢 *ATTENTION EVERYONE* 📢\n\n`
          participants.forEach((p, idx) => {
            announceText += `${idx + 1}. @${p.split('@')[0]}\n`
          })

          await sock.sendMessage(jid, { text: announceText, mentions: participants })
          return
        }
      }

      // Command: .alive
      if (cmd === '.alive') {
        await sock.sendMessage(jid, { text: 'ANONYMOUS BOT is Active ✅ (Connected via MongoDB Cloud)' }).catch(() => {})
        return
      }

      // Command: .song
      if (cmd.startsWith('.song') || cmd.startsWith('.play') || cmd.startsWith('.music')) {
        let songName = text.replace(/^\.(song|play|music)/i, '').trim()
        if (!songName) {
          await sock.sendMessage(jid, { text: '⚠️ Please provide a song name.\n*Example:* `.song Drake Hotline Bling`' }).catch(() => {})
          return
        }
        await fetchSongDetails(songName, jid)
        return
      }
    } catch (err) {
      console.error('Error in message handler:', err)
    }
  })

  // Anti-Delete Handler
  sock.ev.on('messages.update', async updates => {
    if (!global.antiDelete) return
    for (let up of updates) {
      if (up.update.message === null) {
        let stored = msgStore[up.key.remoteJid]?.[up.key.id]

        if (stored && !stored.key.fromMe) {
          let sender = stored.key.participant || stored.key.remoteJid
          let content = stored.message?.conversation || stored.message?.extendedTextMessage?.text || '[Media/Other Message Deleted]'

          await sock.sendMessage(up.key.remoteJid, { 
            text: `🚫 *Anti-Delete Triggered*\n\n@${sender.split('@')[0]} deleted:\n"${content}"`,
            mentions: [sender]
          }).catch(() => {})
        }
      }
    }
  })
}

// Global Process Crash Guards
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err))
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason))

app.post('/api/deploy', (req, res) => {
  const { phoneNumber } = req.body
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' })

  const sessionId = 'primary_user'
  startUserBot(sessionId, phoneNumber, io)

  return res.json({ success: true, sessionId })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`🚀 ANONYMOUS BOT running on http://localhost:${PORT}`))
