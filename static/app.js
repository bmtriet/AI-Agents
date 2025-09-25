const fileEl = document.getElementById('file')
const instrEl = document.getElementById('instruction')
const keepEditedEl = document.getElementById('keepEdited')
const sendBtn = document.getElementById('send')
const chat = document.getElementById('chat')
// Track last processed image id and full_url
let lastEditedId = null
let lastEditedFullUrl = null
// Track last uploaded image (via paste / drag-drop) id and full_url
let lastUploadedId = null
let lastUploadedFilename = null
let lastUploadedFullUrl = null
// pending upload (not yet sent). Structure: {blob, filename, dataUrl}
let pendingUpload = null
const pendingPreviewEl = document.getElementById('pendingPreview')

// helper to create bubbles
function createBubble(who='assistant'){
  const wrap = document.createElement('div')
  wrap.className = 'bubble-in flex gap-3 items-start'
  const avatar = document.createElement('div')
  avatar.className = 'w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold'
  if (who === 'user'){
    avatar.classList.add('bg-slate-600','text-white')
  } else {
    avatar.classList.add('bg-gradient-to-tr','from-indigo-500','to-pink-500','text-white')
  }
  avatar.textContent = who === 'user' ? 'U' : 'AI'

  const content = document.createElement('div')
  content.className = 'prose prose-sm text-slate-100 max-w-full'

  wrap.appendChild(avatar)
  wrap.appendChild(content)
  chat.appendChild(wrap)
  chat.scrollTop = chat.scrollHeight
  return {wrap, content}
}

// Escape HTML to avoid XSS when inserting text nodes
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Append streamed AI text to a content node while handling <think>...</think> blocks.
// This function buffers incomplete tags on the assistant object (assistant._streamBuffer).
function appendStreamedText(assistant, chunk){
  assistant._streamBuffer = assistant._streamBuffer || ''
  const combined = assistant._streamBuffer + (chunk || '')
  let lastIndex = 0
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g
  let m
  while ((m = thinkRegex.exec(combined)) !== null) {
    const start = m.index
    const end = thinkRegex.lastIndex
    // prepend text before this think block
    if (start > lastIndex) {
      const before = combined.slice(lastIndex, start)
      if (before.trim().length) {
        const tn = document.createTextNode(before)
        assistant.content.appendChild(tn)
      }
    }
    // create collapsed think element
    const thinkText = m[1] || ''
    const thinkWrap = document.createElement('div')
    thinkWrap.className = 'think-block'
    thinkWrap.style.fontStyle = 'italic'
    thinkWrap.style.color = '#94a3b8' // slate-400
    thinkWrap.style.fontSize = '0.9em'
    thinkWrap.style.marginTop = '6px'
    thinkWrap.style.marginBottom = '6px'
    thinkWrap.style.padding = '6px 8px'
    thinkWrap.style.background = 'rgba(148,163,184,0.04)'
    thinkWrap.style.borderRadius = '8px'

    const label = document.createElement('div')
    label.textContent = 'Internal thought (click to reveal)'
    label.style.cursor = 'pointer'
    label.style.fontWeight = '600'
    label.style.color = '#cbd5e1'
    label.style.marginBottom = '4px'
    thinkWrap.appendChild(label)

    const hidden = document.createElement('pre')
    hidden.style.display = 'none'
    hidden.style.whiteSpace = 'pre-wrap'
    hidden.style.margin = '0'
    hidden.style.color = '#cbd5e1'
    hidden.textContent = thinkText
    thinkWrap.appendChild(hidden)

    label.addEventListener('click', ()=>{
      if (hidden.style.display === 'none') {
        hidden.style.display = 'block'
        label.textContent = 'Hide internal thought'
      } else {
        hidden.style.display = 'none'
        label.textContent = 'Internal thought (click to reveal)'
      }
      chat.scrollTop = chat.scrollHeight
    })

    assistant.content.appendChild(thinkWrap)
    lastIndex = end
  }

  // leftover after last complete think block
  const leftover = combined.slice(lastIndex)
  // If leftover contains an opening <think> without a closing tag, buffer it
  if (leftover.includes('<think>') && !leftover.includes('</think>')) {
    assistant._streamBuffer = leftover
  } else {
    // safe to append leftover plain text
    if (leftover.length) {
      const tn = document.createTextNode(leftover)
      assistant.content.appendChild(tn)
    }
    assistant._streamBuffer = ''
  }
  chat.scrollTop = chat.scrollHeight
}

// Append a small status line to the assistant bubble without replacing
// the bubble's DOM (important so existing think blocks stay collapsed).
function appendStatus(assistant, msg){
  if (!assistant || !assistant.content) return
  const s = document.createElement('div')
  s.className = 'text-xs text-slate-400 mt-2'
  s.style.whiteSpace = 'pre-wrap'
  s.textContent = msg
  assistant.content.appendChild(s)
  chat.scrollTop = chat.scrollHeight
}

// Append final image block
function appendImage(dataUrl){
  const container = document.createElement('div')
  container.className = 'flex items-center gap-3'
  // thumbnail wrapper to limit displayed size on large screens
  const thumbWrap = document.createElement('div')
  thumbWrap.className = 'rounded-lg overflow-hidden shadow-lg bg-black/10'
  thumbWrap.style.border = '1px solid rgba(148,163,184,0.16)'
  thumbWrap.style.position = 'relative'
  // set reasonable sizes: small preview, clickable to open full
  thumbWrap.style.maxWidth = '320px'
  thumbWrap.style.minWidth = '140px'
  thumbWrap.style.maxHeight = '240px'
  thumbWrap.style.display = 'inline-block'
  const img = document.createElement('img')
  img.src = dataUrl
  img.className = 'block w-full h-auto object-cover'
  img.style.cursor = 'zoom-in'
  img.addEventListener('click', ()=> openLightbox(dataUrl))
  // ensure the image fits into the thumbnail area
  img.style.maxWidth = '100%'
  img.style.height = 'auto'
  // overlay hint
  const hint = document.createElement('div')
  hint.textContent = 'Click to enlarge'
  hint.style.position = 'absolute'
  hint.style.left = '8px'
  hint.style.bottom = '8px'
  hint.style.padding = '4px 8px'
  hint.style.background = 'rgba(0,0,0,0.45)'
  hint.style.color = 'white'
  hint.style.fontSize = '12px'
  hint.style.borderRadius = '6px'
  hint.style.pointerEvents = 'none'
  thumbWrap.appendChild(img)
  thumbWrap.appendChild(hint)
  container.appendChild(thumbWrap)
  chat.appendChild(container)
  chat.scrollTop = chat.scrollHeight
}

// Lightbox functions
const lightbox = document.getElementById('lightbox')
const lightboxImg = document.getElementById('lightboxImg')
const lightboxClose = document.getElementById('lightboxClose')
function openLightbox(src){
  lightboxImg.src = src
  lightbox.classList.remove('hidden')
}
function closeLightbox(){
  lightbox.classList.add('hidden')
  lightboxImg.src = ''
}
lightboxClose.addEventListener('click', closeLightbox)
lightbox.addEventListener('click', (e)=>{ if (e.target === lightbox) closeLightbox() })
// Close lightbox on ESC
document.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape'){
    if (!lightbox.classList.contains('hidden')) closeLightbox()
  }
})

// Quick prompt buttons
document.querySelectorAll('.quick').forEach(b => b.addEventListener('click', ()=>{ instrEl.value = b.textContent.trim() }))

sendBtn.onclick = async () => {
  const instr = instrEl.value || ''
  let useEdited = false
  let useChatOnly = false
  let f = null
  let fromPending = false
  
  // Determine source: pending upload, file upload, reuse last edited, or chat-only text
  if (pendingUpload) {
    // Use the pending pasted/dropped image
    f = pendingUpload.blob
    if (!(f instanceof File)) {
      f = new File([f], pendingUpload.filename, {type: pendingUpload.blob.type || 'image/png'})
    }
    fromPending = true
  } else if (!fileEl.files || fileEl.files.length === 0) {
    // Only reuse the last edited image if the user explicitly checked the "keep editing" box
    if (keepEditedEl && keepEditedEl.checked && lastEditedId && lastEditedFullUrl) {
      useEdited = true
    } else if (instr.trim().length > 0) {
      // allow text-only chat when no image is provided
      useChatOnly = true
    } else {
      alert('Enter a message or select an image to upload.');
      return
    }
  } else {
    f = fileEl.files[0]
  }

  // user bubble
  const userBubble = createBubble('user')
  if (useEdited) {
    userBubble.content.textContent = `Continue editing last image — "${instr}"`
  } else if (useChatOnly) {
    userBubble.content.textContent = instr
  } else if (fromPending) {
    userBubble.content.textContent = `Upload: ${f.name} — "${instr}"`
  } else {
    userBubble.content.textContent = `Upload: ${f.name} — "${instr}"`
  }

  // show a small preview thumbnail in the user bubble (only for image cases)
  if (useEdited) {
    // show the last edited image as the preview (we stored full_url earlier)
    try {
      const src = lastEditedFullUrl.startsWith('http') ? lastEditedFullUrl : window.location.origin + lastEditedFullUrl
  const thumb = document.createElement('img')
  thumb.src = src
  thumb.alt = 'Last edited image preview'
      thumb.className = 'rounded-md mt-2 cursor-zoom-in block'
  // ensure the preview sits directly under the chat text
  thumb.style.display = 'block'
  thumb.style.marginTop = '8px'
  thumb.style.maxWidth = '280px'
      thumb.style.minWidth = '120px'
      thumb.style.maxHeight = '200px'
      thumb.style.objectFit = 'cover'
      thumb.style.border = '1px solid rgba(148,163,184,0.16)'
      thumb.style.position = 'relative'
      const wrapper = document.createElement('div')
      wrapper.style.display = 'inline-block'
      wrapper.style.position = 'relative'
      wrapper.appendChild(thumb)
      const uhint = document.createElement('div')
      uhint.textContent = 'Click to enlarge'
      uhint.style.fontSize = '12px'
      uhint.style.color = '#cbd5e1'
      uhint.style.marginTop = '6px'
      uhint.style.textAlign = 'center'
      uhint.style.pointerEvents = 'none'
      wrapper.appendChild(uhint)
  thumb.addEventListener('click', ()=> openLightbox(src + '?_ts=' + Date.now()))
      userBubble.content.appendChild(wrapper)
    } catch (e) {
      // fallback: no preview
    }
  } else if (!useChatOnly) {
    const reader = new FileReader()
    reader.onload = (ev)=>{
  const thumb = document.createElement('img')
  thumb.src = ev.target.result
  thumb.alt = 'Uploaded image preview'
      // user thumbnail: show small preview but clickable to open full image
      thumb.className = 'rounded-md mt-2 cursor-zoom-in block'
  // ensure the preview sits directly under the chat text
  thumb.style.display = 'block'
  thumb.style.marginTop = '8px'
  thumb.style.maxWidth = '280px'
      thumb.style.minWidth = '120px'
      thumb.style.maxHeight = '200px'
      thumb.style.objectFit = 'cover'
      thumb.style.border = '1px solid rgba(148,163,184,0.16)'
      thumb.style.position = 'relative'
      // hint overlay for user thumb: small caption under the image
      const wrapper = document.createElement('div')
      wrapper.style.display = 'inline-block'
      wrapper.style.position = 'relative'
      wrapper.appendChild(thumb)
      const uhint = document.createElement('div')
      uhint.textContent = 'Click to enlarge'
      uhint.style.fontSize = '12px'
      uhint.style.color = '#cbd5e1'
      uhint.style.marginTop = '6px'
      uhint.style.textAlign = 'center'
      uhint.style.pointerEvents = 'none'
      wrapper.appendChild(uhint)
      thumb.addEventListener('click', ()=> openLightbox(ev.target.result))
      userBubble.content.appendChild(wrapper)
    }
    if (fromPending) {
      // Use the already available dataUrl from pending upload
      reader.onload({ target: { result: pendingUpload.dataUrl } })
    } else {
      reader.readAsDataURL(f)
    }
  }

  let paramsObj = {}
  let j = null
  if (useChatOnly) {
    // no upload step
    paramsObj = {instruction: instr}
  } else if (!useEdited) {
    const form = new FormData()
    form.append('image', f)
    form.append('instruction', instr)
    // If the assistant previously returned a tool call, we could attach it to the stream later.
    let uploadUrl = '/upload'
    const res = await fetch(uploadUrl, {method:'POST', body: form})
    j = await res.json()
    if (j.error){
      const errB = createBubble('assistant')
      errB.content.textContent = 'Upload error: ' + j.error
      return
    }
    // Clear the file input so that an empty input signals "use last edited image"
    try { fileEl.value = '' } catch (e) { /* ignore */ }
    // Clear pending upload if it was used
    if (fromPending) {
      pendingUpload = null
      if (pendingPreviewEl) pendingPreviewEl.innerHTML = ''
    }
    paramsObj = {id: j.id, filename: j.filename, instruction: instr}
  } else {
    // reuse lastEditedId and instruct server to use edited image
    paramsObj = {id: lastEditedId, filename: '', instruction: instr, source: 'edited'}
  }

  // create an assistant streaming bubble
  const assistant = createBubble('assistant')
  assistant.content.classList.add('assistant-stream','px-3','py-2','rounded-xl')
  assistant.content.textContent = ''

    // store last tool call returned by the assistant (if any)
    window.lastToolCall = window.lastToolCall || null

  // Clear the instruction input after sending (normal chat behavior)
  try{ instrEl.value = '' }catch(e){}

  // Prefer using local Ollama streaming if enabled. Set window.USE_OLLAMA = true in the console to try.
  const params = new URLSearchParams(paramsObj)
  // If the client previously captured a tool call, append it so server can skip parsing
  try{
    if (!useChatOnly && window.lastToolCall) {
      const opName = window.lastToolCall.name || window.lastToolCall.operation || window.lastToolCall.tool || null
      const opArgs = window.lastToolCall.arguments || window.lastToolCall.args || window.lastToolCall.params || window.lastToolCall.op_params || null
      if (opName) {
        params.append('operation', opName)
        try{ params.append('op_params', JSON.stringify(opArgs || {})) }catch(e){}
      }
    }
  }catch(e){}
  // pick endpoint: chat-only uses /chat, otherwise use /stream with params
  const endpoint = useChatOnly ? ('/chat?instruction=' + encodeURIComponent(instr)) : ('/stream?' + params.toString())

  // Helper: robust Ollama stream consumer. Returns an object with cancel() and resolves when done.
  async function generateOllamaStream({
    prompt,
    model = 'llama3',
    url = 'http://localhost:11434/api/generate',
    onOpen = () => {},
    onChunk,
    onError = (err) => console.error(err),
    onDone = () => {},
    signal
  } = {}){
    if (typeof onChunk !== 'function') throw new Error('onChunk callback is required')
    const controller = new AbortController()
    if (signal){ if (signal.aborted) controller.abort(); else signal.addEventListener('abort', ()=> controller.abort(), {once:true}) }

    let response
    try{
      response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({model, prompt, stream: true}),
        signal: controller.signal
      })
    }catch(err){ onError(err); throw err }

    if (!response.ok){ const t = await response.text().catch(()=>''); const err = new Error(`Stream request failed: ${response.status} ${response.statusText} ${t}`); onError(err); throw err }
    if (!response.body){ const err = new Error('No response body from Ollama'); onError(err); throw err }

    onOpen()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const result = { cancel: () => controller.abort() }

    try{
      while(true){
        const {value, done} = await reader.read()
        if (done) break
        buffer += decoder.decode(value, {stream: true})
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines){
          const trimmed = line.trim()
          if (!trimmed) continue
          const jsonText = trimmed.replace(/^data:\s*/, '')
          try{
            const data = JSON.parse(jsonText)
            if (data.done){ onDone(); try{ reader.releaseLock() }catch(e){}; return result }
            if (typeof data.response === 'string') { onChunk(data.response); continue }
            if (typeof data.token === 'string') { onChunk(data.token); continue }
            if (typeof data.output === 'string') { onChunk(data.output); continue }
            if (data.choices?.length){
              for (const c of data.choices){ if (typeof c.delta === 'string') onChunk(c.delta); else if (c.delta?.content) onChunk(c.delta.content) }
              continue
            }
            onChunk(JSON.stringify(data))
          }catch(err){ onError(new Error('Malformed JSON chunk: '+err.message+' -- chunk: '+jsonText)) }
        }
      }

      const final = buffer.trim()
      if (final){
        try{ const data = JSON.parse(final); if (!data.done){ if (typeof data.response === 'string') onChunk(data.response); else if (typeof data.token === 'string') onChunk(data.token); else onChunk(JSON.stringify(data)) } }catch(err){ onError(new Error('Malformed final JSON chunk: '+err.message)) }
      }

      onDone()
      return result
    }catch(err){ onError(err); throw err }
    finally{ try{ reader.releaseLock() }catch(e){} }
  }

  // If a global flag is set, attempt Ollama streaming; otherwise fall back to server SSE.
  const useOllama = !!window.USE_OLLAMA
  if (useOllama){
    try{
      const promptText = instr || ''
      const streamHandle = await generateOllamaStream({
        prompt: promptText,
        model: 'llama3',
        onOpen: ()=>{/* no-op */},
    onChunk: (txt)=> appendStreamedText(assistant, txt),
  onError: (err)=>{ appendStatus(assistant, '[stream error]'); console.error('Ollama stream error', err) },
  onDone: ()=> { appendStatus(assistant, '[done]'); }
      })
      // streamHandle.cancel can be used to cancel if needed
    }catch(err){
      console.warn('Ollama streaming failed, falling back to SSE /stream', err)
      // fallback to EventSource below
  const es = new EventSource(endpoint)
      es.onmessage = (ev) => {
        try{
          const payload = JSON.parse(ev.data)
              if (payload.type === 'ai'){
              const txt = payload.text || ''
              appendStreamedText(assistant, txt)
              // detect a tool call text and store it for later (client may send it with uploads)
              if (txt.startsWith('Tool call:')){
                try{
                  const jsonText = txt.replace(/^Tool call:\s*/, '')
                  window.lastToolCall = JSON.parse(jsonText)
                }catch(e){}
              }
            if (/\bDone\b/i.test(txt) || /Finished|Done|Done\b/.test(txt)){
              try{ es.close() }catch(e){}
            }
          } else if (payload.type === 'image'){
            const thumb = payload.thumbnail
            const full = payload.full_url
            const container = document.createElement('div')
            container.className = 'flex items-center gap-3'
            const thumbWrap = document.createElement('div')
            thumbWrap.className = 'rounded-lg overflow-hidden shadow-lg bg-black/10'
            thumbWrap.style.maxWidth = '320px'
            thumbWrap.style.minWidth = '140px'
            thumbWrap.style.maxHeight = '240px'
            thumbWrap.style.display = 'inline-block'
            const img = document.createElement('img')
            img.src = thumb
            img.className = 'block w-full h-auto object-cover'
            img.style.cursor = 'zoom-in'
            img.addEventListener('click', ()=> openLightbox(window.location.origin + full + '?_ts=' + Date.now()))
            thumbWrap.appendChild(img)
            container.appendChild(thumbWrap)
            chat.appendChild(container)
            chat.scrollTop = chat.scrollHeight
            try{
              const editedMatch = full.match(/\/uploads\/(.+)_edited\.png$/)
              if (editedMatch) {
                lastEditedId = editedMatch[1]
                lastEditedFullUrl = full
              } else {
                console.warn('Received image full_url does not look like an edited full image:', full)
              }
            }catch(e){ console.error(e) }
            try{ es.close() }catch(e){}
          }
        }catch(e){ console.error('parse', e) }
      }
  es.onerror = (e) => { appendStatus(assistant, ''); es.close() }
    }
  } else {
  // default: use the chosen server-sent events endpoint
  const es = new EventSource(endpoint)

    es.onmessage = (ev) => {
      try{
        const payload = JSON.parse(ev.data)
        if (payload.type === 'ai'){
          const txt = payload.text || ''
          appendStreamedText(assistant, txt)
          if (/\bDone\b/i.test(txt) || /Finished|Done|Done\b/.test(txt)){
            try{ es.close() }catch(e){}
          }
        } else if (payload.type === 'image'){
          const thumb = payload.thumbnail
          const full = payload.full_url
          const container = document.createElement('div')
          container.className = 'flex items-center gap-3'
          const thumbWrap = document.createElement('div')
          thumbWrap.className = 'rounded-lg overflow-hidden shadow-lg bg-black/10'
          thumbWrap.style.maxWidth = '320px'
          thumbWrap.style.minWidth = '140px'
          thumbWrap.style.maxHeight = '240px'
          thumbWrap.style.display = 'inline-block'
          const img = document.createElement('img')
          img.src = thumb
          img.className = 'block w-full h-auto object-cover'
          img.style.cursor = 'zoom-in'
          img.addEventListener('click', ()=> openLightbox(window.location.origin + full + '?_ts=' + Date.now()))
          thumbWrap.appendChild(img)
          container.appendChild(thumbWrap)
          chat.appendChild(container)
          chat.scrollTop = chat.scrollHeight
          try{
            const editedMatch = full.match(/\/uploads\/(.+)_edited\.png$/)
            if (editedMatch) {
              lastEditedId = editedMatch[1]
              lastEditedFullUrl = full
            } else {
              console.warn('Received image full_url does not look like an edited full image:', full)
            }
          }catch(e){ console.error(e) }
          try{ es.close() }catch(e){}
        }
      }catch(e){ console.error('parse', e) }
    }

  es.onerror = (e) => { appendStatus(assistant, ''); es.close() }
  }
}

// Helper: upload a Blob or File to server /upload and return parsed JSON
async function uploadBlob(blob, filenameHint='pasted.png'){
  const form = new FormData()
  // try to create a File so server sees a proper filename
  let fileToSend = blob
  try{
    if (!(blob instanceof File)){
      fileToSend = new File([blob], filenameHint, {type: blob.type || 'image/png'})
    }
  }catch(e){ /* some browsers may not allow File ctor; send blob directly */ }
  form.append('image', fileToSend)
  form.append('instruction', '')
  // choose upload endpoint and do a single fetch
  let uploadUrl = '/upload'
  const res = await fetch(uploadUrl, {method:'POST', body: form})
  const j = await res.json()
  return j
}

// Show a small user bubble preview for uploaded images (paste / drop)
function showUploadedPreview(dataUrl, filename, id){
  // If called before user sends, show preview in the pending area
  if (pendingPreviewEl){
    pendingPreviewEl.innerHTML = ''
    const wrapper = document.createElement('div')
    wrapper.className = 'flex items-center gap-2'
    const img = document.createElement('img')
    img.src = dataUrl
    img.className = 'rounded-md cursor-zoom-in block'
    img.style.maxWidth = '120px'
    img.style.maxHeight = '90px'
    img.style.objectFit = 'cover'
    img.addEventListener('click', ()=> openLightbox(dataUrl))
    const meta = document.createElement('div')
    meta.className = 'text-xs text-slate-300'
    meta.textContent = filename || 'pasted image'
    const cancel = document.createElement('button')
    cancel.textContent = 'Remove'
    cancel.className = 'ml-2 text-xs text-red-400'
    cancel.addEventListener('click', ()=>{ pendingUpload = null; pendingPreviewEl.innerHTML = '' })
    wrapper.appendChild(img)
    wrapper.appendChild(meta)
    wrapper.appendChild(cancel)
    pendingPreviewEl.appendChild(wrapper)
  }
  // store uploaded id/filename for later use if needed
  lastUploadedId = id || lastUploadedId
  lastUploadedFilename = filename || lastUploadedFilename
  if (id && filename){ lastUploadedFullUrl = `/uploads/${id}_${filename}` }
}

// Paste handler: listen for image data in clipboard and upload it (but do not start an edit)
document.addEventListener('paste', async (e)=>{
  try{
    const items = (e.clipboardData && e.clipboardData.items) || []
    for (const it of items){
      if (it.type && it.type.startsWith('image/')){
        const blob = it.getAsFile() || it.getAsFile()
        if (!blob) continue
        // show local preview immediately
        const reader = new FileReader()
        reader.onload = async (ev)=>{
          // stage pending upload instead of immediately sending
          pendingUpload = { blob: blob, filename: blob.name || 'pasted.png', dataUrl: ev.target.result }
          showUploadedPreview(ev.target.result, pendingUpload.filename, null)
        }
        reader.readAsDataURL(blob)
        // only handle first image
        break
      }
    }
  }catch(err){ console.error('paste upload failed', err) }
})

// Drag & drop handler on chat area: upload dropped image(s) without sending
chat.addEventListener('dragover', (e)=>{ e.preventDefault(); e.dataTransfer.dropEffect = 'copy' })
chat.addEventListener('drop', async (e)=>{
  e.preventDefault()
  try{
    const files = Array.from(e.dataTransfer.files || [])
    for (const f of files){
      if (!f.type.startsWith('image/')) continue
      // show preview immediately
      const reader = new FileReader()
      reader.onload = (ev)=>{
        // stage pending upload
        pendingUpload = { blob: f, filename: f.name, dataUrl: ev.target.result }
        showUploadedPreview(ev.target.result, f.name, null)
      }
      reader.readAsDataURL(f)
      // only handle first image for now
      break
    }
  }catch(err){ console.error('drop upload failed', err) }
})




  // Allow pressing Enter to send the chat. Use Shift+Enter for a newline.
  instrEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      try { sendBtn.click() } catch (err) { /* ignore */ }
    }
  })

