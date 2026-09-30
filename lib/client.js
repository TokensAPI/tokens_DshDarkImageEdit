window.__ModuleLoader__.load({
  id: '@tokensapi/dsh-dark-image-edit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var jsx = require('react/jsx-runtime')
    var React = require('react')
    var ReactDOM = require('react-dom')

    var editorButton = { border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: 8, padding: '6px 10px', background: 'var(--dsw-specific-input-major)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: 13 }
    var MIN_EDITOR_ZOOM = 0.25
    var MAX_EDITOR_ZOOM = 8

    function clampEditorZoom(value, fitScale) {
      if (!Number.isFinite(value)) return 1
      return Math.min(Math.max(MAX_EDITOR_ZOOM, 1 / fitScale), Math.max(MIN_EDITOR_ZOOM, value))
    }

    function drawAnnotation(ctx, mark) {
      ctx.strokeStyle = mark.color
      ctx.lineWidth = mark.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (mark.tool === 'rect') {
        ctx.strokeRect(mark.start.x, mark.start.y, mark.end.x - mark.start.x, mark.end.y - mark.start.y)
      } else if (mark.tool === 'line') {
        ctx.beginPath()
        ctx.moveTo(mark.start.x, mark.start.y)
        ctx.lineTo(mark.end.x, mark.end.y)
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.moveTo(mark.points[0].x, mark.points[0].y)
        if (mark.points.length === 1) ctx.lineTo(mark.points[0].x + 0.01, mark.points[0].y + 0.01)
        else mark.points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y))
        ctx.stroke()
      }
    }

    function DraftImageEditor({ attachment, onSave, onClose }) {
      var canvasRef = React.useRef(null)
      var viewportRef = React.useRef(null)
      var imageRef = React.useRef(null)
      var marksRef = React.useRef([])
      var activeRef = React.useRef(null)
      var panRef = React.useRef(null)
      var pendingZoomRef = React.useRef(null)
      var gestureStartZoomRef = React.useRef(1)
      var zoomRef = React.useRef(1)
      var [ready, setReady] = React.useState(false)
      var [tool, setTool] = React.useState('pen')
      var [color, setColor] = React.useState('#ef4444')
      var [width, setWidth] = React.useState(4)
      var [count, setCount] = React.useState(0)
      var [busy, setBusy] = React.useState(false)
      var [error, setError] = React.useState('')
      var [zoom, setZoom] = React.useState(1)
      var [spaceHeld, setSpaceHeld] = React.useState(false)
      var [panning, setPanning] = React.useState(false)
      var [imageSize, setImageSize] = React.useState({ width: 0, height: 0 })
      var [viewportSize, setViewportSize] = React.useState({ width: 0, height: 0 })
      zoomRef.current = zoom
      var fitScale = imageSize.width && imageSize.height && viewportSize.width && viewportSize.height
        ? Math.min(1, viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
        : 1
      var displayWidth = imageSize.width * fitScale * zoom
      var displayHeight = imageSize.height * fitScale * zoom

      function changeZoom(next, clientX, clientY) {
        var viewport = viewportRef.current
        var canvas = canvasRef.current
        if (!ready || !viewport || !canvas) return
        var viewportRect = viewport.getBoundingClientRect()
        var canvasRect = canvas.getBoundingClientRect()
        var anchorX = Number.isFinite(clientX) ? clientX : viewportRect.left + viewportRect.width / 2
        var anchorY = Number.isFinite(clientY) ? clientY : viewportRect.top + viewportRect.height / 2
        pendingZoomRef.current = {
          imageX: canvasRect.width ? Math.min(1, Math.max(0, (anchorX - canvasRect.left) / canvasRect.width)) : 0.5,
          imageY: canvasRect.height ? Math.min(1, Math.max(0, (anchorY - canvasRect.top) / canvasRect.height)) : 0.5,
          clientX: anchorX,
          clientY: anchorY,
        }
        setZoom((current) => clampEditorZoom(typeof next === 'function' ? next(current) : next, fitScale))
      }

      React.useLayoutEffect(() => {
        var anchor = pendingZoomRef.current
        var viewport = viewportRef.current
        var canvas = canvasRef.current
        if (!anchor || !viewport || !canvas) return
        pendingZoomRef.current = null
        var rect = canvas.getBoundingClientRect()
        viewport.scrollLeft += rect.left + anchor.imageX * rect.width - anchor.clientX
        viewport.scrollTop += rect.top + anchor.imageY * rect.height - anchor.clientY
      }, [zoom, imageSize.width, imageSize.height, viewportSize.width, viewportSize.height])

      React.useEffect(() => {
        var viewport = viewportRef.current
        if (!viewport) return
        function measure() {
          var width = viewport.clientWidth
          var height = viewport.clientHeight
          setViewportSize((current) => current.width === width && current.height === height ? current : { width, height })
        }
        measure()
        var observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer) observer.observe(viewport)
        else window.addEventListener('resize', measure)
        return () => {
          if (observer) observer.disconnect()
          else window.removeEventListener('resize', measure)
        }
      }, [])

      React.useEffect(() => {
        var viewport = viewportRef.current
        if (!viewport) return
        function wheel(event) {
          if (!ready || busy) return
          event.preventDefault()
          var pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1)
          var exponent = Math.max(-0.4, Math.min(0.4, -pixels * 0.002))
          changeZoom((current) => current * Math.exp(exponent), event.clientX, event.clientY)
        }
        function gestureStart(event) {
          if (!ready || busy) return
          event.preventDefault()
          gestureStartZoomRef.current = zoomRef.current
        }
        function gestureChange(event) {
          if (!ready || busy) return
          event.preventDefault()
          if (Number.isFinite(event.scale)) changeZoom(gestureStartZoomRef.current * event.scale, event.clientX, event.clientY)
        }
        viewport.addEventListener('wheel', wheel, { passive: false })
        viewport.addEventListener('gesturestart', gestureStart, { passive: false })
        viewport.addEventListener('gesturechange', gestureChange, { passive: false })
        return () => {
          viewport.removeEventListener('wheel', wheel)
          viewport.removeEventListener('gesturestart', gestureStart)
          viewport.removeEventListener('gesturechange', gestureChange)
        }
      }, [ready, busy])

      function redraw() {
        var canvas = canvasRef.current
        var image = imageRef.current
        if (!canvas || !image) return
        var ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        marksRef.current.forEach((mark) => drawAnnotation(ctx, mark))
        if (activeRef.current) drawAnnotation(ctx, activeRef.current)
      }

      React.useEffect(() => {
        var image = new Image()
        var live = true
        image.onload = () => {
          if (!live) return
          var canvas = canvasRef.current
          if (!canvas || !image.naturalWidth || !image.naturalHeight) {
            setError('无法读取图片尺寸。')
            return
          }
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          imageRef.current = image
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight })
          setReady(true)
          redraw()
        }
        image.onerror = () => { if (live) setError('无法打开这张图片。') }
        image.src = attachment.previewUrl
        return () => { live = false; image.onload = null; image.onerror = null }
      }, [attachment.id])

      React.useEffect(() => {
        function keydown(event) {
          if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
          if (event.code === 'Space' && !busy && !event.repeat && !event.target?.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target?.tagName)) {
            event.preventDefault()
            setSpaceHeld(true)
          }
        }
        function keyup(event) { if (event.code === 'Space') setSpaceHeld(false) }
        window.addEventListener('keydown', keydown)
        window.addEventListener('keyup', keyup)
        return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup) }
      }, [busy, onClose])

      function point(event) {
        var canvas = canvasRef.current
        var rect = canvas.getBoundingClientRect()
        return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }
      }

      function start(event) {
        if (!ready || busy || activeRef.current || panRef.current || event.button === 2) return
        var viewport = viewportRef.current
        if (tool === 'hand' || spaceHeld || event.button === 1) {
          event.preventDefault()
          viewport.setPointerCapture(event.pointerId)
          panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop }
          setPanning(true)
          return
        }
        if (event.target !== canvasRef.current) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        var p = point(event)
        activeRef.current = tool === 'rect' || tool === 'line' ? { tool, color, width, start: p, end: p, pointerId: event.pointerId } : { tool, color, width, points: [p], pointerId: event.pointerId }
        redraw()
      }

      function move(event) {
        var pan = panRef.current
        if (pan && pan.pointerId === event.pointerId) {
          var viewport = viewportRef.current
          viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.x)
          viewport.scrollTop = pan.scrollTop - (event.clientY - pan.y)
          return
        }
        var mark = activeRef.current
        if (!mark || mark.pointerId !== event.pointerId) return
        var p = point(event)
        if (mark.tool === 'rect' || mark.tool === 'line') mark.end = p
        else mark.points.push(p)
        redraw()
      }

      function finish(event) {
        if (panRef.current?.pointerId === event.pointerId) {
          panRef.current = null
          setPanning(false)
          return
        }
        if (activeRef.current?.pointerId !== event.pointerId) return
        move(event)
        marksRef.current.push(activeRef.current)
        activeRef.current = null
        setCount(marksRef.current.length)
        redraw()
      }

      function cancel(event) {
        if (panRef.current?.pointerId === event.pointerId) {
          panRef.current = null
          setPanning(false)
        }
        if (activeRef.current?.pointerId === event.pointerId) {
          activeRef.current = null
          redraw()
        }
      }

      function undo() {
        marksRef.current.pop()
        setCount(marksRef.current.length)
        redraw()
      }

      async function save() {
        if (!ready || busy) return
        setBusy(true)
        setError('')
        try {
          redraw()
          var blob = await new Promise((resolve, reject) => canvasRef.current.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 导出失败')), 'image/png'))
          var base = attachment.file.name.replace(/\.[^.]+$/, '') || 'image'
          var file = new File([blob], `${base}-marked.png`, { type: 'image/png', lastModified: Date.now() })
          await onSave(file)
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
          setBusy(false)
        }
      }

      return ReactDOM.createPortal(jsx.jsx('div', {
        role: 'dialog', 'aria-modal': true, 'aria-label': '发送前编辑图片',
        style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.78)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 18, boxSizing: 'border-box', color: '#fff' },
        children: jsx.jsxs('div', { style: { width: 'min(100%, 1100px)', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }, children: [
          jsx.jsxs('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }, children: [
            jsx.jsx('strong', { style: { marginRight: 10 }, children: '编辑待发送图片' }),
            jsx.jsx('button', { type: 'button', onClick: () => setTool('pen'), 'aria-pressed': tool === 'pen', style: { ...editorButton, outline: tool === 'pen' ? '2px solid #ef4444' : 'none' }, children: '画笔' }),
            jsx.jsx('button', { type: 'button', onClick: () => setTool('rect'), 'aria-pressed': tool === 'rect', style: { ...editorButton, outline: tool === 'rect' ? '2px solid #ef4444' : 'none' }, children: '方框' }),
            jsx.jsx('button', { type: 'button', onClick: () => setTool('line'), 'aria-pressed': tool === 'line', style: { ...editorButton, outline: tool === 'line' ? '2px solid #ef4444' : 'none' }, children: '直线' }),
            jsx.jsx('button', { type: 'button', onClick: () => setTool('hand'), 'aria-pressed': tool === 'hand', style: { ...editorButton, outline: tool === 'hand' ? '2px solid #ef4444' : 'none' }, children: '移动' }),
            jsx.jsx('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13 }, children: ['颜色', jsx.jsx('input', { type: 'color', value: color, onChange: (event) => setColor(event.target.value), 'aria-label': '画笔颜色', style: { width: 36, height: 30, padding: 0, border: 0, background: 'transparent', cursor: 'pointer' } })] }),
            jsx.jsx('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13 }, children: ['粗细', jsx.jsx('input', { type: 'range', min: 1, max: 24, value: width, onChange: (event) => setWidth(Number(event.target.value)), 'aria-label': '线条粗细' }), String(width)] }),
            jsx.jsx('button', { type: 'button', onClick: undo, disabled: count === 0 || busy, style: editorButton, children: '撤销' }),
            jsx.jsx('span', { style: { width: 1, height: 22, background: 'rgba(255,255,255,.25)', margin: '0 2px' }, 'aria-hidden': true }),
            jsx.jsx('button', { type: 'button', onClick: () => changeZoom((current) => current / 1.25), disabled: !ready || busy, style: editorButton, 'aria-label': '缩小图片', children: '−' }),
            jsx.jsx('span', { style: { minWidth: 42, textAlign: 'center', fontSize: 13 }, 'aria-label': '当前图片倍率', children: `${Math.round(zoom * 100)}%` }),
            jsx.jsx('button', { type: 'button', onClick: () => changeZoom((current) => current * 1.25), disabled: !ready || busy, style: editorButton, 'aria-label': '放大图片', children: '+' }),
            jsx.jsx('button', { type: 'button', onClick: () => changeZoom(1), disabled: !ready || busy, style: editorButton, children: '适应窗口' }),
            jsx.jsx('button', { type: 'button', onClick: () => changeZoom(1 / fitScale), disabled: !ready || busy, style: editorButton, children: '原始尺寸' }),
          ] }),
          jsx.jsx('div', { ref: viewportRef, onPointerDown: start, onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel, onLostPointerCapture: cancel, style: { flex: 1, minHeight: 0, overflow: 'auto', background: '#181818', borderRadius: 10, touchAction: 'none', cursor: panning ? 'grabbing' : tool === 'hand' || spaceHeld ? 'grab' : 'crosshair' }, 'aria-label': '图片编辑视区', children: jsx.jsx('div', { style: { width: Math.max(viewportSize.width, displayWidth), height: Math.max(viewportSize.height, displayHeight), display: 'flex', alignItems: 'center', justifyContent: 'center' }, children: jsx.jsx('canvas', { ref: canvasRef, style: { width: displayWidth, height: displayHeight, flex: 'none', display: 'block', cursor: 'inherit' }, 'aria-label': '图片标注画布' }) }) }),
          error ? jsx.jsx('div', { role: 'alert', style: { color: '#ff9a9a', fontSize: 13 }, children: error }) : null,
          jsx.jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 }, children: [
            jsx.jsx('button', { type: 'button', onClick: onClose, disabled: busy, style: editorButton, children: '取消' }),
            jsx.jsx('button', { type: 'button', onClick: save, disabled: !ready || busy, style: { ...editorButton, background: '#d83434', color: '#fff', borderColor: '#d83434' }, children: busy ? '保存中…' : '保存到待发送区' }),
          ] }),
        ] }),
      }), document.body)
    }

    function DraftAttachments({ attachments, canAcceptDrop, onAddFiles, onRemoveAttachment, uploads, onRetryFile, inputActions, sessions, conversation }) {
      var [editing, setEditing] = React.useState(null)
      var [error, setError] = React.useState('')
      var sessionId = useSessionId(sessions)
      var currentRef = React.useRef(attachments)
      currentRef.current = attachments

      React.useEffect(() => {
        function onDrop(event) {
          if (!event.dataTransfer || !event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          if (canAcceptDrop) onAddFiles(Array.from(event.dataTransfer.files))
        }
        function onDragOver(event) {
          if (!event.dataTransfer || !event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
        }
        document.addEventListener('drop', onDrop)
        document.addEventListener('dragover', onDragOver)
        return () => { document.removeEventListener('drop', onDrop); document.removeEventListener('dragover', onDragOver) }
      }, [canAcceptDrop, onAddFiles])

      async function replace(file) {
        var old = currentRef.current.find((item) => item.id === editing.id)
        if (!old || !sessionId || !inputActions) throw new Error('待发送图片已变化，请重新打开编辑器。')
        var drafts = conversation.createDrafts(sessionId, [file])
        var next = drafts[0]
        if (!next || next.kind !== 'image') throw new Error('无法创建编辑后的图片附件。')
        if (!inputActions.addAttachments([next.id])) {
          conversation.releaseDraftAttachment(next.id)
          throw new Error('当前正在发送消息，请稍后再保存。')
        }
        var later = currentRef.current.slice(currentRef.current.findIndex((item) => item.id === old.id) + 1).map((item) => item.id)
        onRemoveAttachment(old.id)
        later.forEach((id) => inputActions.removeAttachment(id))
        if (later.length && !inputActions.addAttachments(later)) throw new Error('图片已保存，但附件顺序未能恢复。')
        setEditing(null)
      }

      return jsx.jsxs(jsx.Fragment, { children: [
        attachments.length ? jsx.jsx('div', { style: { display: 'flex', gap: 10, overflowX: 'auto', padding: '8px 4px 4px', minHeight: 70 }, role: 'group', 'aria-label': '待发送附件', children: attachments.map((item) => jsx.jsxs('div', { style: { position: 'relative', flex: 'none', width: 72, height: 72, borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)' }, children: [
          item.kind === 'image' ? jsx.jsxs(jsx.Fragment, { children: [
            jsx.jsx('img', { src: item.previewUrl, alt: item.file.name || '待发送图片', style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } }),
            jsx.jsx('button', { type: 'button', onClick: () => { setError(''); setEditing(item) }, style: { position: 'absolute', left: 3, bottom: 3, border: 0, borderRadius: 5, background: 'rgba(0,0,0,.76)', color: '#fff', fontSize: 11, padding: '3px 5px', cursor: 'pointer' }, 'aria-label': `编辑 ${item.file.name || '图片'}`, children: '编辑' }),
          ] }) : jsx.jsxs('div', { style: { padding: '10px 5px 4px', fontSize: 11, overflowWrap: 'anywhere', lineHeight: 1.2 }, children: [item.file.name || '文件', jsx.jsx('div', { style: { marginTop: 4, opacity: .7 }, children: uploads[item.id]?.status === 'ready' ? '已就绪' : uploads[item.id]?.status === 'error' ? '上传失败' : '上传中' })] }),
          jsx.jsx('button', { type: 'button', onClick: () => onRemoveAttachment(item.id), style: { position: 'absolute', top: 2, right: 2, border: 0, borderRadius: '50%', width: 18, height: 18, padding: 0, background: 'rgba(0,0,0,.76)', color: '#fff', cursor: 'pointer', lineHeight: '18px' }, 'aria-label': `移除 ${item.file.name || '附件'}`, children: '×' }),
          item.kind === 'file' && uploads[item.id]?.status === 'error' ? jsx.jsx('button', { type: 'button', onClick: () => onRetryFile(item.id), style: { position: 'absolute', left: 3, bottom: 3, border: 0, borderRadius: 5, background: 'rgba(0,0,0,.76)', color: '#fff', fontSize: 11, cursor: 'pointer' }, children: '重试' }) : null,
        ] }, item.id)) }) : null,
        error ? jsx.jsx('div', { role: 'alert', style: { color: '#ef4444', fontSize: 12 }, children: error }) : null,
        editing ? jsx.jsx(DraftImageEditor, { attachment: editing, onClose: () => setEditing(null), onSave: replace }) : null,
      ] })
    }

    function textLines(block) {
      if (!block || !Array.isArray(block.content)) return ''
      return block.content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }

    function remoteImageUrls(block) {
      var text = textLines(block)
      var matches = text.matchAll(/(?:Image\s+\d+|URL):\s*(https:\/\/\S+)/g)
      return Array.from(matches, (match) => match[1])
    }

    function imageAttachments(block) {
      if (!block || !Array.isArray(block.content)) return []
      return block.content
        .filter((part) => part && part.type === 'image' && part.attachment && typeof part.attachment.attachmentId === 'string')
        .map((part) => part.attachment)
    }

    function compactDownloadTimestamp(date) {
      var pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    }

    function imageTaskId(block) {
      var match = textLines(block).match(/\btask\s+([A-Za-z0-9_-]+)\)/i)
      return match ? match[1] : ''
    }

    function imageDownloadName(attachment, url, index, taskId, timestamp) {
      var mediaType = attachment && typeof attachment.mediaType === 'string' ? attachment.mediaType : ''
      var extension = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif',
      }[mediaType]
      if (!extension && typeof url === 'string' && /^https:\/\//i.test(url)) {
        try {
          var match = new URL(url).pathname.match(/\.(png|jpe?g|webp|gif)$/i)
          if (match) extension = `.${match[1].toLowerCase().replace('jpeg', 'jpg')}`
        } catch {}
      }
      var identity = taskId || (attachment && typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '')
      var taskSuffix = String(identity).replace(/[^A-Za-z0-9_-]/g, '').slice(-10)
      return `dark-image-edit-${index + 1}-${timestamp}${taskSuffix ? `-${taskSuffix}` : ''}${extension || '.png'}`
    }

    function imageDownloadUrl(url, filename) {
      if (typeof url !== 'string' || !url) return null
      if (url.startsWith('blob:') || url.startsWith('data:')) return url
      try {
        var source = new URL(url)
        if (source.protocol === 'https:' && source.hostname === 's3.tokensapi.ai') {
          return `/dark-image-edit/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(filename)}`
        }
      } catch {}
      return url
    }

    function useSessionId(sessions) {
      return React.useSyncExternalStore(
        sessions.list.subscribe,
        () => sessions.list.getSnapshot().current,
        () => undefined,
      )
    }

    function useAttachmentUrls(attachments, fallbackUrls, sessions) {
      var sessionId = useSessionId(sessions)
      var key = attachments.map((item) => item.attachmentId).join('|')
      var fallbackKey = fallbackUrls.join('|')
      var [state, setState] = React.useState({ urls: fallbackUrls, loading: attachments.length > 0, error: null })

      React.useEffect(() => {
        var live = true
        var objectUrls = []
        setState({ urls: fallbackUrls, loading: attachments.length > 0, error: null })
        if (!attachments.length || !sessionId) return () => { live = false }
        var session = sessions.binding(sessionId)?.session
        if (!session) return () => { live = false }
        Promise.all(attachments.map((attachment) =>
          session.readAttachment(attachment.attachmentId).then((result) => {
            if (!result.ok) throw new Error(result.error?.message || 'Attachment read failed')
            var bytes = result.value.data
            var url = URL.createObjectURL(new Blob([bytes], { type: result.value.attachment.mediaType }))
            objectUrls.push(url)
            return url
          }),
        )).then((urls) => {
          if (live) setState({ urls, loading: false, error: null })
        }).catch((error) => {
          if (live) setState({ urls: fallbackUrls, loading: false, error: String(error?.message || error) })
        })
        return () => {
          live = false
          objectUrls.forEach((url) => URL.revokeObjectURL(url))
        }
      }, [key, fallbackKey, sessionId, sessions])
      return state
    }

    function Header({ title, status }) {
      return jsx.jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, lineHeight: '20px' },
        children: [
          jsx.jsx('span', { style: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }, children: title }),
          jsx.jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary)' }, children: status }),
        ],
      })
    }

    function Notice({ children, error }) {
      return jsx.jsx('div', {
        style: { color: error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)', fontSize: 13, whiteSpace: 'pre-wrap' },
        children,
      })
    }

    function MediaImageRow({ toolName, block, sessions }) {
      var done = 'kind' in block
      var [previewUrl, setPreviewUrl] = React.useState(null)
      React.useEffect(() => {
        if (!previewUrl) return undefined
        function onKeyDown(event) {
          if (event.key === 'Escape') setPreviewUrl(null)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [previewUrl])
      var attachments = done ? imageAttachments(block) : []
      var fallbacks = done ? remoteImageUrls(block) : []
      var images = useAttachmentUrls(attachments, fallbacks, sessions)
      var taskId = done ? imageTaskId(block) : ''
      var downloadTimestamp = compactDownloadTimestamp(new Date())
      var title = 'Edit image'
      var status = !done ? 'editing…' : block.isError ? 'failed' : 'done'
      var warningLines = done ? textLines(block).split('\n').filter((line) => /warning:|failed|error/i.test(line)) : []

      return jsx.jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 4px' },
        children: [
          jsx.jsx(Header, { title, status }),
          images.loading ? jsx.jsx(Notice, { children: 'Loading image attachments…' }) : null,
          images.urls.length ? jsx.jsx('div', {
            style: { display: 'grid', gridTemplateColumns: images.urls.length === 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: 8 },
            children: images.urls.map((url, index) => {
              var filename = imageDownloadName(attachments[index], url, index, taskId, downloadTimestamp)
              var downloadUrl = imageDownloadUrl(url, filename)
              return jsx.jsxs('div', {
                style: { position: 'relative', minWidth: 0, overflow: 'hidden', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)' },
                children: [
                  jsx.jsx('div', {
                    role: 'button',
                    'aria-label': '放大预览图片',
                    onClick: () => setPreviewUrl(url),
                    style: { display: 'block', minWidth: 0, cursor: 'zoom-in' },
                    children: jsx.jsx('img', {
                      src: url,
                      alt: `Edited image ${index + 1}`,
                      loading: 'lazy',
                      style: { width: '100%', maxHeight: 480, borderRadius: 12, display: 'block', objectFit: 'contain', background: 'var(--dsw-alias-bg-layer-1)' },
                    }),
                  }),
                  downloadUrl ? jsx.jsx('a', {
                    href: downloadUrl,
                    download: filename,
                    title: '下载图片',
                    'aria-label': '下载图片',
                    style: { position: 'absolute', top: 10, right: 10, zIndex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, border: '1px solid rgba(255,255,255,.28)', borderRadius: 9, background: 'rgba(0,0,0,.58)', color: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,.22)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', textDecoration: 'none' },
                    children: jsx.jsx('svg', {
                      width: 18,
                      height: 18,
                      viewBox: '0 0 24 24',
                      fill: 'none',
                      'aria-hidden': true,
                      children: jsx.jsx('path', {
                        d: 'M12 3v11m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2',
                        stroke: 'currentColor',
                        strokeWidth: 1.8,
                        strokeLinecap: 'round',
                        strokeLinejoin: 'round',
                      }),
                    }),
                  }) : null,
                ],
              }, `${url}:${index}`)
            }),
          }) : !images.loading ? jsx.jsx(Notice, { error: done, children: done ? 'No edited image was returned.' : 'Editing image…' }) : null,
          images.error ? jsx.jsx(Notice, { error: true, children: `Attachment fallback: ${images.error}` }) : null,
          warningLines.length ? jsx.jsx(Notice, { error: true, children: warningLines.join('\n') }) : null,
          previewUrl ? jsx.jsxs('div', {
            role: 'dialog',
            'aria-label': '图片放大预览',
            style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.72)', backdropFilter: 'blur(6px)', cursor: 'zoom-out', onClick: () => setPreviewUrl(null) },
            children: [
              jsx.jsx('img', {
                src: previewUrl,
                alt: '图片放大预览',
                style: { maxWidth: '92vw', maxHeight: '92vh', borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,.5)', objectFit: 'contain' },
              }),
              jsx.jsx('button', {
                'aria-label': '关闭预览',
                onClick: (event) => { event.stopPropagation(); setPreviewUrl(null) },
                style: { position: 'absolute', top: 16, right: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, border: 'none', borderRadius: '50%', background: 'rgba(255,255,255,.16)', color: '#fff', fontSize: 22, lineHeight: 1, cursor: 'pointer' },
                children: '\u00d7',
              }),
            ],
          }) : null,
        ],
      })
    }

    var inject = ['slots', 'sessions', 'conversation']

    function apply(ctx) {
      var sessions = ctx.get('sessions')
      var conversation = ctx.get('conversation')
      var ImageRow = (props) => jsx.jsx(MediaImageRow, { ...props, sessions })
      var AttachmentEditor = (props) => jsx.jsx(DraftAttachments, { ...props, sessions, conversation })
      ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({ name: 'conversation.input.attachments', priority: -1, locale: 'conversation' }, AttachmentEditor))
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'image_edit', locale: 'conversation' }, ImageRow))
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'image_edit_status', locale: 'conversation' }, ImageRow))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
