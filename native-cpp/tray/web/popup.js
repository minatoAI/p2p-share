/* 托盘小窗。数据全是示例，原生侧只负责托盘、选文件、写剪贴板、收起窗口。
 *
 * 设备切换会换掉下面的记录——切到哪台设备，看到的就是那台设备的剪贴板和传输。
 */
(() => {
  const bridge = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const real = Boolean(bridge);
  const params = new URLSearchParams(location.search);
  const forcedState = params.get('state');
  const shot = params.get('shot') === '1';
  const rootEl = document.documentElement;
  const themeParam = params.get('theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  // 打开时跟随系统（或截图参数），之后按钮只在亮/暗之间切
  const initialTheme =
    themeParam === 'dark' || themeParam === 'light' ? themeParam : systemDark ? 'dark' : 'light';
  let currentTheme = initialTheme;
  rootEl.dataset.theme = currentTheme;
  let vtBusy = false;

  const $ = (id) => document.getElementById(id);

  const MOCK = {
    devices: [
      { name: '办公室电脑', online: true },
      { name: '我的手机', online: false },
    ],
    clips: [
      { device: '办公室电脑', text: '2026 年第三季度复盘：托盘端、局域网直连、剪贴板同步三条主线。', meta: '2 分钟前' },
      { device: '办公室电脑', text: 'https://p2p-share-web.pages.dev/s/9f3a2c', meta: '1 小时前' },
      { device: '办公室电脑', text: 'HUAWEI-5G-8C21　密码 8842 1190', meta: '昨天' },
      { device: '我的手机', text: '明天十点，老地方见', meta: '10 分钟前' },
      { device: '我的手机', text: 'https://maps.example.com/q=31.23,121.47', meta: '昨天' },
    ],
    shares: [
      { name: '产品演示.mp4', size: '68.2 MB', time: '今天 14:02', downloads: 3, link: 'https://p2p-share-web.pages.dev/s/8f2c4a91' },
      { name: '截图-2026-10-20.png', size: '2.1 MB', time: '昨天', downloads: 0, link: 'https://p2p-share-web.pages.dev/s/1d7e0b52' },
    ],
    transfers: [
      { device: '办公室电脑', name: '会议纪要-10月.txt', size: '2.4 KB', dir: 'out', status: 'done', time: '3 分钟前', path: '' },
      { device: '办公室电脑', name: '产品图标.png', size: '22.1 KB', dir: 'in', status: 'done', time: '昨天', path: '' },
      { device: '办公室电脑', name: '产品演示.mp4', size: '68.2 MB', dir: 'in', status: 'active', progress: 62, time: '正在接收', path: '' },
      { device: '我的手机', name: 'IMG_2048.jpg', size: '3.1 MB', dir: 'in', status: 'done', time: '昨天', path: '' },
      { device: '我的手机', name: '报销单.pdf', size: '420 KB', dir: 'out', status: 'done', time: '3 天前', path: '' },
    ],
  };

  const state = {
    savePath: '',
    devices: [],
    transfers: [],
    shares: [],
    clips: [],
    target: '',
    tab: 'clip',
    view: 'home',
    picked: null,
    link: '',
    myClip: '',
    clipFiles: [],
    conn: 'idle',
    connDetail: '',
    code: '',
    pairLink: '',
    showMyCode: false,
    peerName: '',
    peerId: '',
    targetId: '',
    presence: [],
    contacts: [],
    pendingSend: false,
    notifySound: 'balloon',
    sounds: [],
    autosync: false,
    autostart: false,
    sendto: false,
    pairAsk: null,
    fileTarget: null,
    pendingDeviceName: '',
  };

  // ---------- 小工具 ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function post(message) {
    if (bridge) bridge.postMessage(message);
  }

  function toast(text) {
    const node = $('toast');
    node.textContent = text;
    node.hidden = false;
    requestAnimationFrame(() => node.classList.add('show'));
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => (node.hidden = true), 200);
    }, 1600);
  }

  function humanish(bytes) {
    if (!bytes) return '未知大小';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  function extOf(name) {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  }

  function iconLabel(name) {
    return (extOf(name) || 'file').slice(0, 4).toUpperCase();
  }

  function iconClass(name) {
    const ext = extOf(name);
    return ['txt', 'png', 'jpg', 'mp4', 'zip'].includes(ext) ? ext : 'default';
  }

  /**
   * 配对过的设备（通讯录）加上灯塔报的在线状态。
   * 重启后通讯录还在，没有 presence 也能看见这些设备并点着重连。
   */
  function knownDevices() {
    const map = new Map();
    for (const item of state.contacts || []) {
      map.set(item.id, { id: item.id, name: item.name || item.id.slice(0, 8), online: false });
    }
    for (const item of state.presence || []) {
      if (map.has(item.id)) {
        map.get(item.id).online = Boolean(item.online);
        continue;
      }
      map.set(item.id, {
        id: item.id,
        name: item.name || item.id.slice(0, 8),
        online: Boolean(item.online),
      });
    }
    return [...map.values()];
  }

  function currentDevice() {
    if (real) {
      const list = knownDevices();
      const device =
        list.find((item) => item.id === state.targetId) ||
        list.find((item) => item.id === state.peerId) ||
        list[0];
      if (!device) {
        return { id: '', name: state.peerName || '', online: state.conn === 'connected' };
      }
      return {
        ...device,
        online: state.conn === 'connected' && (!state.peerId || device.id === state.peerId),
      };
    }
    return state.devices.find((item) => item.name === state.target) || state.devices[0] || { name: '', online: false };
  }

  // ---------- 渲染 ----------

  function render() {
    renderHeader();
    renderBanner();
    renderTabs();
    renderClips();
    renderFiles();
    updateBusy();
  }

  /** 有正在传的东西就告诉原生侧：托盘图标开始动。 */
  function isConnected() {
    return real ? state.conn === 'connected' : Boolean(currentDevice().online);
  }

  /** 主按钮跟着当前能力走：能直连就发文件；连不上时创建分享链接不需要对方在线。 */
  function updateSendButton() {
    const connected = isConnected();
    const hasFiles = state.clipFiles.length > 0;
    const imageOnly = state.clipFiles.length === 1 && state.clipFiles[0].kind === 'image';
    $('sendLabel').textContent = connected ? '发送文件' : '创建分享链接';
    if (connected) {
      $('sendHint').textContent = hasFiles
        ? imageOnly
          ? '剪贴板里有图片，点此发送'
          : `剪贴板里有 ${state.clipFiles.length} 个文件，点此发送`
        : '可发给设备，或创建分享链接';
    } else {
      const offline = real ? state.conn === 'offline' : !currentDevice().online;
      $('sendHint').textContent = offline
        ? '对方离线，可以先创建分享链接'
        : '点这里创建分享链接，不需要对方在线';
    }
    $('pickMenu').hidden = false;
  }

  function updateBusy() {
    post({ t: 'busy', on: state.transfers.some((item) => item.status === 'active') });
  }

  function renderHeader() {
    if (real) {
      $('deviceName').textContent = state.peerName || state.deviceName || '这台电脑';
      // X-2：头栏主状态只用这五个词。连灯塔、建连这类过渡态不当主状态，
      // 进度说明留在 title/detail 里，避免同一个状态在三端三种说法。
      const labels = {
        idle: '在线',
        'lighthouse-connecting': '在线',
        ready: '在线',
        pairing: '配对中',
        connecting: '在线',
        offline: '对方离线',
        connected: '已连接',
        error: '连接失败',
      };
      const transitional = state.conn === 'lighthouse-connecting' || state.conn === 'connecting';
      $('deviceState').textContent = labels[state.conn] || '在线';
      $('deviceState').title = state.connDetail || (transitional ? '正在连接…' : '');
      $('deviceDot').classList.toggle('off', state.conn !== 'connected');
      updateSendButton();
      return;
    }
    const device = currentDevice();
    $('deviceName').textContent = device.name || '没有设备';
    $('deviceState').textContent = device.online ? '已连接' : '对方离线';
    $('deviceDot').classList.toggle('off', !device.online);
    updateSendButton();
  }

  function renderBanner() {
    $('saveBanner').hidden = Boolean(state.savePath) || state.view !== 'home';
  }

  function renderTabs() {
    $('tabs').dataset.active = state.tab;
    for (const tab of document.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
    }
    $('clipHead').hidden = state.tab !== 'clip';
    $('clipList').hidden = state.tab !== 'clip';
    $('fileList').hidden = state.tab !== 'files';
  }

  /** 剪贴板只放对方发过来的文字；最新一条单独一张卡，其余进历史。 */
  function renderClips() {
    const list = $('clipList');
    list.innerHTML = '';
    const clips = real
      ? state.clips
      : state.clips.filter((clip) => clip.device === state.target);
    if (!clips.length) {
      list.append(el('div', 'empty', '对方还没发过文字'));
      return;
    }
    const row = (clip, latest) => {
      const item = el('div', `row clip${latest ? ' latest' : ''}`);
      const body = el('div', 'clip-body');
      if (latest) body.append(el('span', 'clip-latest-label', '最新收到'));
      body.append(el('span', 'clip-text', clip.text));
      item.append(body, el('span', 'clip-meta', clip.meta));
      item.title = '点击复制到这台电脑';
      item.addEventListener('click', () => {
        post({ t: 'copy', text: clip.text });
        item.classList.add('flash');
        const meta = item.querySelector('.clip-meta');
        meta.textContent = '已复制';
        clearTimeout(item.timer);
        item.timer = setTimeout(() => {
          item.classList.remove('flash');
          meta.textContent = clip.meta;
        }, 1200);
        toast('已复制到剪贴板');
      });
      return item;
    };
    list.append(row(clips[0], true));
    if (clips.length > 1) {
      list.append(el('div', 'clip-history-hd', '更早的记录'));
      for (const clip of clips.slice(1)) list.append(row(clip, false));
    }
  }

  function metaText(transfer) {
    const direction = transfer.dir === 'out' ? '发往' : '收自';
    return `${transfer.size} · ${direction} ${transfer.device} · ${transfer.time}`;
  }

  function statusText(transfer) {
    if (transfer.status === 'active') {
      return `${transfer.dir === 'out' ? '发送中' : '接收中'} ${Math.round(transfer.progress || 0)}%`;
    }
    if (transfer.status === 'canceled') return transfer.note || '已取消';
    if (transfer.status === 'error') return transfer.note || '失败';
    return '已完成';
  }

  function fileRow(transfer) {
    const row = el('div', 'row file');
    if (transfer.status === 'done' && transfer.path && transfer.dir === 'in') {
      row.title = '双击查看文件操作';
    }
    row.append(el('span', `ficon ${iconClass(transfer.name)}`, iconLabel(transfer.name)));
    const main = el('div', 'file-main');
    main.append(el('span', 'file-name', transfer.name), el('span', 'file-meta', metaText(transfer)));
    if (transfer.status === 'active') {
      const bar = el('span', 'bar');
      const fill = el('i');
      fill.style.width = `${Math.max(2, Math.min(100, transfer.progress || 0))}%`;
      bar.append(fill);
      main.append(bar);
    }
    const end = el('div', 'file-end');
    end.append(
      el('span', `status${transfer.status === 'active' ? ' active' : ''}`, statusText(transfer)),
    );
    const dots = el('button', 'dots', '⋯');
    dots.title = '更多';
    dots.setAttribute('aria-haspopup', 'menu');
    dots.setAttribute('aria-expanded', 'false');
    dots.addEventListener('click', (event) => {
      event.stopPropagation();
      openRowMenu(transfer, dots);
    });
    end.append(dots);
    row.append(main);
    row.append(end);
    row.addEventListener('dblclick', () => {
      if (transfer.dir === 'in' && transfer.path) openFileConfirm(transfer);
    });
    return row;
  }

  function shareRow(share) {
    const row = el('div', 'row file');
    row.append(el('span', `ficon ${iconClass(share.name)}`, iconLabel(share.name)));
    const main = el('div', 'file-main');
    const meta = share.downloads
      ? `${share.downloads} 人正在下载 · ${share.size} · ${share.time}`
      : `暂无下载 · ${share.size} · ${share.time}`;
    main.append(el('span', 'file-name', share.name), el('span', 'file-meta', meta));
    const end = el('div', 'file-end');
    const downloading = share.phase === 'connecting' || share.phase === 'sending';
    const status = share.phase === 'failed' ? '这次没发成' : downloading ? '正在发送' : '分享中';
    end.append(el('span', `status${downloading ? ' active' : ''}`, status));
    const dots = el('button', 'dots', '⋯');
    dots.title = '更多';
    dots.setAttribute('aria-haspopup', 'menu');
    dots.setAttribute('aria-expanded', 'false');
    dots.addEventListener('click', (event) => {
      event.stopPropagation();
      openShareMenu(share, dots);
    });
    end.append(dots);
    row.append(main);
    row.append(end);
    return row;
  }

  function relTime(at) {
    if (!at) return '';
    const diff = Date.now() - at;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  function applyHistory(message) {
    const items = (message.items || []).map((entry) => {
      // 磁盘和事件里这个字段叫 at（毫秒时间戳）；早期这里读的是 at_ms，
      // 于是每条记录的"时间"都是空的，文件信息框里只剩一个孤零零的"·"。
      const at = entry.at_ms || entry.at || 0;
      return {
        id: entry.id || '',
        name: entry.name,
        size: humanish(entry.size || 0),
        meta: `${entry.direction === 'in' ? '收自' : '发往'} ${entry.peer || '对方'} · ${relTime(
          at,
        )}`,
        status: 'done',
        progress: 100,
        dir: entry.direction === 'in' ? 'in' : 'out',
        incoming: entry.direction === 'in',
        device: entry.peer || state.peerName || '对方',
        path: entry.path || '',
        at,
        time: relTime(at),
      };
    });
    if (!message.append) {
      state.transfers = items;
      renderFiles();
      updateBusy();
      return;
    }
    // 传输完成时原生会先发一条 history。把正在进行的同一行就地收尾，
    // 而不是再加一条，否则会出现"100% 接收中"和"已完成"两条。
    for (const item of items) {
      let index = item.id
        ? state.transfers.findIndex((row) => row.status === 'active' && row.id === item.id)
        : -1;
      if (index < 0) {
        // 老消息可能没有 id；接收落盘会自动改名，所以再退一步按方向+原名找
        index = state.transfers.findIndex(
          (row) => row.status === 'active' && row.dir === item.dir && row.name === item.name,
        );
      }
      if (index >= 0) {
        const active = state.transfers[index];
        state.transfers[index] = { ...item, id: item.id || active.id };
      } else {
        state.transfers.unshift(item);
      }
    }
    renderFiles();
    updateBusy();
  }

  function applyProgress(message) {
    const total = message.total || 0;
    const pct = total ? Math.max(1, Math.min(100, Math.round((message.done / total) * 100))) : 0;
    // 已经收尾的那条（完成/取消/失败）再来一条晚到的进度，不能另起一行。
    // 上一版这里会新建，列表里就多了个永远"接收中 100%"的影子记录。
    if (
      message.id &&
      state.transfers.some((item) => item.status !== 'active' && item.id === message.id)
    ) {
      return;
    }
    // id 用来取消：同名文件可能同时有两条在传，不能只靠名字找
    let row = state.transfers.find(
      (item) => item.status === 'active' && item.id && item.id === message.id,
    );
    if (!row) {
      row = state.transfers.find(
        (item) => item.status === 'active' && !item.id && item.name === message.name,
      );
    }
    if (!row) {
      row = {
        name: message.name,
        size: humanish(total),
        device: state.peerName || state.target || '对方',
        status: 'active',
        progress: pct,
        dir: message.incoming ? 'in' : 'out',
        incoming: Boolean(message.incoming),
        time: '刚刚',
        path: '',
      };
      state.transfers.unshift(row);
    }
    row.id = message.id;
    row.incoming = Boolean(message.incoming);
    row.dir = message.incoming ? 'in' : 'out';
    row.progress = pct;
    renderFiles();
    updateBusy();
  }

  function renderPairCode() {
    const box = $('myCodeBox');
    if (!box) return;
    const showing = state.showMyCode && Boolean(state.code);
    box.hidden = !showing;
    const view = $('view-pair');
    if (view) view.classList.toggle('showing-code', showing);
    const lede = $('pairLede');
    if (lede) {
      lede.textContent = showing
        ? '让对方扫码，或在它的「在线互传」里输入这六位数字。'
        : '在另一台设备上打开「在线互传」，输入它显示的六位数字。';
    }
    if (state.code) $('myCode').textContent = state.code;
    renderPairQr();
  }

  /** 把配对链接画成二维码。code 有、link 还没到时退化成只编码六位数字。 */
  function renderPairQr() {
    const box = $('pairQrBox');
    const canvas = $('pairQr');
    const copy = $('copyPairLink');
    const payload = state.pairLink || state.code;
    if (!box || !canvas || !payload || typeof window.qrcode !== 'function') {
      if (box) box.hidden = true;
      if (copy) copy.hidden = true;
      return;
    }
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(payload);
      qr.make();
      const count = qr.getModuleCount();
      const ctx = canvas.getContext('2d');
      const size = canvas.width;
      const cell = size / count;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#111';
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (!qr.isDark(row, col)) continue;
          const x = Math.round(col * cell);
          const y = Math.round(row * cell);
          ctx.fillRect(x, y, Math.round((col + 1) * cell) - x, Math.round((row + 1) * cell) - y);
        }
      }
      box.hidden = false;
      if (copy) copy.hidden = !state.pairLink;
    } catch {
      box.hidden = true;
      if (copy) copy.hidden = true;
    }
  }

  // ---------- 扫码 ----------
  //
  // 两条路共用同一个解码器和同一段"认出来之后怎么办"：
  //   - 摄像头：每 220ms 抽一帧，缩到 640 宽再解，不追每一帧；
  //   - 图片：截屏或照片里的码也能认，没有摄像头的台式机就靠它。
  let scanStream = null;
  let scanTimer = null;
  const scanCanvas = document.createElement('canvas');

  function stopScan() {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    if (scanStream) {
      for (const track of scanStream.getTracks()) track.stop();
      scanStream = null;
    }
    const video = $('scanVideo');
    if (video) video.srcObject = null;
  }

  /** 只认 `#c=123456` 或裸的六位数字；别把分享 token 当成配对码。 */
  function extractPairCode(text) {
    const raw = String(text || '').trim();
    const matched = /[#&?]c=(\d{6})(?:&|$)/.exec(raw);
    if (matched) return matched[1];
    if (/^\d{6}$/.test(raw)) return raw;
    return null;
  }

  function acceptScan(text) {
    const code = extractPairCode(text);
    if (!code) {
      $('scanDesc').textContent = '这个码里没有六位配对数字，换一个试试。';
      return;
    }
    stopScan();
    $('pairCode').value = code;
    if (real) {
      stopAdvertising();
      post({ t: 'join', code });
      toast(`正在连接 ${code}`);
      showView('home');
    } else {
      toast(`示例里扫到 ${code}，真实模式会直接连接`);
    }
  }

  async function openScan() {
    showView('scan');
    const veil = $('scanVeil');
    const desc = $('scanDesc');
    veil.hidden = false;
    veil.textContent = '正在打开摄像头…';
    desc.textContent = '把对方设备上的二维码放进框里，认出来就会自动连接。';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      veil.textContent = '这台电脑没有可用的摄像头，选一张二维码图片也可以。';
      return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (state.view !== 'scan') {
        for (const track of scanStream.getTracks()) track.stop();
        scanStream = null;
        return;
      }
      const video = $('scanVideo');
      video.srcObject = scanStream;
      await video.play();
      veil.hidden = true;
      scanTimer = setInterval(decodeScanFrame, 220);
    } catch {
      veil.hidden = false;
      veil.textContent = '摄像头打不开，选一张二维码图片也可以。';
      desc.textContent = '摄像头可能被占用，或系统没给权限。';
    }
  }

  function decodeScanFrame() {
    const video = $('scanVideo');
    if (!video || typeof window.jsQR !== 'function') return;
    if (video.readyState < 2 || !video.videoWidth) return;
    const width = Math.min(640, video.videoWidth);
    const height = Math.round((video.videoHeight * width) / video.videoWidth);
    scanCanvas.width = width;
    scanCanvas.height = height;
    const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const found = window.jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' });
    if (found && found.data) acceptScan(found.data);
  }

  async function decodeScanFile(file) {
    if (!file || typeof window.jsQR !== 'function') return;
    try {
      const bitmap = await createImageBitmap(file);
      const width = Math.min(900, bitmap.width);
      const height = Math.round((bitmap.height * width) / bitmap.width);
      scanCanvas.width = width;
      scanCanvas.height = height;
      const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, width, height);
      if (bitmap.close) bitmap.close();
      const image = ctx.getImageData(0, 0, width, height);
      const found = window.jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' });
      if (found && found.data) {
        acceptScan(found.data);
        return;
      }
      $('scanDesc').textContent = '没认出二维码，换一张清楚一点的图片试试。';
    } catch {
      $('scanDesc').textContent = '这张图片读不出来，换一张试试。';
    }
  }

  function renderFiles() {
    const direct = $('directBody');
    direct.innerHTML = '';
    const files = real
      ? state.transfers
      : state.transfers.filter((item) => item.device === state.target);
    if (!files.length) {
      direct.append(el('div', 'empty', '这台设备还没有传输记录'));
    } else {
      for (const transfer of files) direct.append(fileRow(transfer));
    }
    $('directCount').textContent = files.length ? `${files.length} 项` : '';

    const shared = $('sharesBody');
    shared.innerHTML = '';
    if (!state.shares.length) {
      shared.append(
        el('div', 'empty', '还没有分享链接。点下面的「发送文件」，在下拉里选「创建分享链接」。'),
      );
    } else {
      for (const share of state.shares) shared.append(shareRow(share));
    }
    $('sharesCount').textContent = state.shares.length ? `${state.shares.length} 项` : '';
    requestAnimationFrame(refreshFades);
  }

  /** 内容超出可视高度时，底部加一层淡出，提示"下面还有"。 */
  function refreshFades() {
    for (const body of document.querySelectorAll('.group-body, .settings-body, .view')) {
      const more = body.scrollHeight - body.scrollTop - body.clientHeight > 4;
      body.classList.toggle('fade', more && body.scrollHeight > body.clientHeight + 2);
    }
  }

  function openShareMenu(share, anchor) {
    openMenuAt(anchor, (menu) => {
      const copy = el('button');
      copy.textContent = '复制链接';
      copy.addEventListener('click', () => {
        closeMenu();
        post({ t: 'copy', text: share.link });
        toast('链接已复制');
      });
      const stop = el('button');
      stop.className = 'danger';
      stop.textContent = '撤销分享';
      stop.addEventListener('click', () => {
        closeMenu();
        // 链接一撤，别人手里那条就打不开了，不给一次确认太容易误点
        askConfirm({
          kicker: '撤销链接',
          title: '撤销这条链接？',
          desc: '撤销后这条链接立刻失效，已经拿到链接的人也打不开。',
          okText: '确认撤销',
          cancelText: '返回',
          danger: true,
          onOk: () => {
            if (real) {
              post({ t: 'revoke-share', token: share.token });
            } else {
              state.shares = state.shares.filter((item) => item !== share);
              renderFiles();
            }
            toast('已撤销分享');
          },
        });
      });
      menu.append(copy, stop);
    });
  }

  // ---------- 视图 ----------

  function showView(view) {
    if (state.view === 'scan' && view !== 'scan') stopScan();
    state.view = view;
    // 首页对应的是列表视图（view-list），不是 view-home
    const visible = view === 'home' ? 'list' : view;
    for (const name of ['list', 'send', 'link', 'pair', 'settings', 'scan']) {
      $(`view-${name}`).hidden = name !== visible;
    }
    $('homeFt').hidden = view !== 'home';
    $('tabs').hidden = view !== 'home';
    renderBanner();
    closeMenu();
    // 换页面时确认框不该悬在新页面上
    closeConfirm(false);
    requestAnimationFrame(refreshFades);
  }

  function setTab(tab) {
    state.tab = tab;
    renderTabs();
  }

  /** 离开配对页时别让码一直轮换、一直弹 toast。 */
  function stopAdvertising() {
    if (!state.showMyCode) return;
    state.showMyCode = false;
    renderPairCode();
    post({ t: 'stop-advertise' });
  }

  function cancelPendingSend() {
    state.pendingSend = false;
    state.picked = null;
  }

  /** 子页返回：扫码回添加设备，其余回首页；离开发送流程就不再自动发。 */
  function goBack() {
    if (state.view === 'scan') {
      showView('pair');
      return;
    }
    if (state.view === 'pair') stopAdvertising();
    if (state.view === 'send' || state.view === 'pair' || state.view === 'link') {
      cancelPendingSend();
    }
    showView('home');
  }

  // ---------- 设置 ----------

  function renderSettings() {
    const nameInput = $('setDeviceName');
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = state.deviceName || '';
    }
    $('setSavePathText').textContent = state.savePath || '选择文件夹…';
    $('setSavePath').title = state.savePath || '';
    $('setAutosync').checked = Boolean(state.autosync);
    $('setAutostart').checked = Boolean(state.autostart);
    $('setSendto').checked = Boolean(state.sendto);
    const select = $('setSound');
    const wanted = state.sounds.map((item) => item.name).join('|');
    if (select.dataset.items !== wanted) {
      select.innerHTML = '';
      for (const item of state.sounds) {
        const option = el('option', null, item.label || item.name);
        option.value = item.name;
        select.append(option);
      }
      select.dataset.items = wanted;
    }
    if (state.notifySound) select.value = state.notifySound;
    renderContacts();
  }

  /** 已配对设备列表。改名/删除都在这张表里就地做，不用弹系统对话框。 */
  function saveDeviceName() {
    const input = $('setDeviceName');
    const name = input.value.trim();
    if (!name) {
      toast('名字不能为空');
      input.focus();
      return;
    }
    // 界面按字符数算，原生也按字符数校验；中文名不能按字节提前截断
    if ([...name].length > 32) {
      toast('名字最多 32 个字符');
      input.focus();
      return;
    }
    if (name === state.deviceName) return;
    state.pendingDeviceName = name;
    post({ t: 'set-device-name', name });
  }

  function renderContacts(force = false) {
    const box = $('contactList');
    if (!box) return;
    const signature = state.contacts.map((item) => `${item.id}:${item.name}`).join('|');
    if (!force && box.dataset.signature === signature && box.childElementCount) return;
    box.dataset.signature = signature;
    box.innerHTML = '';
    if (!state.contacts.length) {
      box.append(el('div', 'ask', '还没有配对过的设备'));
      requestAnimationFrame(refreshFades);
      return;
    }
    for (const contact of state.contacts) {
      const row = el('div', 'contact-row');
      const name = el('button', 'contact-name', contact.name || contact.id.slice(0, 8));
      name.title = '点一下改名';
      name.addEventListener('click', () => beginRename(row, contact));
      const remove = el('button', 'contact-del', '删除');
      remove.addEventListener('click', () => confirmRemove(row, contact));
      row.append(name, remove);
      box.append(row);
    }
    requestAnimationFrame(refreshFades);
  }

  function beginRename(row, contact) {
    row.innerHTML = '';
    const input = el('input', 'text-input');
    input.value = contact.name || '';
    input.maxLength = 32;
    const save = el('button', 'mini primary', '保存');
    const cancel = el('button', 'mini', '取消');
    row.append(input, save, cancel);
    input.focus();
    input.select();
    const commit = () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      if (name !== contact.name) {
        contact.name = name;
        // 先按新名字显示，等原生回执再提示成不成；写盘失败会连名字一起回滚
        post({ t: 'rename-contact', id: contact.id, name });
      }
      renderContacts(true);
      renderHeader();
      renderTargets();
    };
    save.addEventListener('click', commit);
    cancel.addEventListener('click', () => renderContacts(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit();
      if (event.key === 'Escape') renderContacts(true);
    });
  }

  function confirmRemove(row, contact) {
    row.innerHTML = '';
    const ask = el('div', 'ask', `删除「${contact.name}」？`);
    const yes = el('button', 'mini primary', '删除');
    const no = el('button', 'mini', '取消');
    row.append(ask, yes, no);
    yes.addEventListener('click', () => {
      state.contacts = state.contacts.filter((item) => item.id !== contact.id);
      if (state.targetId === contact.id) state.targetId = '';
      post({ t: 'remove-contact', id: contact.id });
      renderContacts(true);
      renderTargets();
      toast('已删除');
    });
    no.addEventListener('click', () => renderContacts(true));
  }

  /** 原生下发的设置快照：init 和每次 state 回执都用这一套字段。 */
  function applySettings(message) {
    if (typeof message.savePath === 'string') state.savePath = message.savePath;
    if (typeof message.notifySound === 'string') state.notifySound = message.notifySound;
    if (typeof message.autoSync === 'boolean') state.autosync = message.autoSync;
    if (typeof message.autostart === 'boolean') state.autostart = message.autostart;
    if (typeof message.sendto === 'boolean') state.sendto = message.sendto;
    if (Array.isArray(message.sounds) && message.sounds.length) {
      state.sounds = message.sounds;
    }
    if (message.deviceName) state.deviceName = message.deviceName;
    renderSettings();
  }

  // ---------- 菜单 ----------

  let menuAnchor = null;

  function closeMenu() {
    const menu = $('popmenu');
    menu.hidden = true;
    menu.innerHTML = '';
    if (menuAnchor) {
      menuAnchor.classList.remove('open');
      menuAnchor.setAttribute('aria-expanded', 'false');
      menuAnchor = null;
    }
  }

  function openMenuAt(anchor, build) {
    const menu = $('popmenu');
    // 同一个「⋯」再点一下就是收起；这是用户最自然的关闭方式。
    if (!menu.hidden && menuAnchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();
    build(menu);
    menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(rect.left, window.innerWidth - width - 8);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
    menuAnchor = anchor;
    anchor.classList.add('open');
    anchor.setAttribute('aria-expanded', 'true');
  }

  function openDeviceMenu() {
    openMenuAt($('deviceBtn'), (menu) => {
      const devices = real ? knownDevices() : state.devices;
      if (real && !devices.length) {
        const empty = el('div', 'empty', '还没有配对过的设备');
        menu.append(empty);
      }
      for (const device of devices) {
        const button = el('button');
        const connected = real && state.conn === 'connected' && state.peerId === device.id;
        const connecting =
          real && state.conn === 'connecting' && state.targetId === device.id;
        button.append(
          el('span', `dot${device.online || connected ? '' : ' off'}`),
          el('span', null, device.name),
          el('span', 'sub', connected ? '已连接' : connecting ? '正在连接' : device.online ? '在线' : '对方离线'),
        );
        button.addEventListener('click', () => {
          if (real) {
            closeMenu();
            state.targetId = device.id;
            if (state.conn === 'connected' && state.peerId === device.id) {
              toast(`已经连着 ${device.name}`);
              return;
            }
            connectContact(device);
            return;
          }
          state.target = device.name;
          closeMenu();
          render();
          toast(`切换到了 ${device.name}`);
        });
        menu.append(button);
      }
      if (real && state.conn === 'connected') {
        const stop = el('button');
        stop.append(
          el('span', null, '断开连接'),
          el('span', 'sub', state.peerName || ''),
        );
        stop.addEventListener('click', () => {
          closeMenu();
          post({ t: 'disconnect' });
          toast('已断开');
        });
        menu.append(stop);
      }
      menu.append(el('div', 'sep'));
      const add = el('button');
      add.append(el('span', null, '添加设备…'), el('span', 'sub', '输码或扫码'));
      add.addEventListener('click', () => {
        closeMenu();
        state.showMyCode = false;
        renderPairCode();
        showView('pair');
        setTimeout(() => $('pairCode').focus(), 60);
      });
      menu.append(add);
    });
  }

  /** 从通讯录连回去。手上已经选了文件的话，连上后自动发。 */
  function connectContact(device) {
    if (!device || !device.id) return;
    if (state.conn === 'connecting' && state.targetId === device.id) {
      toast(`正在连接 ${device.name}…`);
      return;
    }
    state.targetId = device.id;
    state.peerName = device.name || state.peerName;
    if (state.picked) state.pendingSend = true;
    post({ t: 'connect', id: device.id });
    renderTargets();
    toast(`正在连接 ${device.name}`);
  }

  function openRowMenu(transfer, anchor) {
    openMenuAt(anchor, (menu) => {
      if (transfer.status === 'active') {
        const button = el('button');
        button.textContent = '取消这次传输';
        button.addEventListener('click', () => {
          closeMenu();
          if (real) {
            post({ t: 'cancel-transfer', id: transfer.id || '', incoming: transfer.incoming });
            toast('正在取消…');
          } else {
            // 示例数据没有真的传输，直接把这一行收尾
            transfer.status = 'canceled';
            renderFiles();
            updateBusy();
            toast('已取消');
          }
        });
        menu.append(button);
        return;
      }
      if (transfer.path) {
        const actions = [
          ['查看文件信息', () => openFileConfirm(transfer)],
          ['在文件管理器中打开', () => post({ t: 'reveal', path: transfer.path })],
          [
            '另存为…',
            () => {
              post({ t: 'copy-file-as', path: transfer.path, name: transfer.name });
              toast('选择要保存的位置');
            },
          ],
          [
            '复制路径',
            () => {
              post({ t: 'copy', text: transfer.path });
              toast('路径已复制');
            },
          ],
        ];
        for (const [label, action] of actions) {
          const button = el('button');
          button.textContent = label;
          button.addEventListener('click', () => {
            closeMenu();
            action();
          });
          menu.append(button);
        }
        return;
      }
      const button = el('button');
      button.textContent = '复制文件名';
      button.addEventListener('click', () => {
        closeMenu();
        post({ t: 'copy', text: transfer.name });
        toast('文件名已复制');
      });
      menu.append(button);
    });
  }

  /* ---------- 文件操作确认 ---------- */

  function openFileConfirm(transfer) {
    if (!transfer || !transfer.path) {
      toast('这条记录没有本地文件');
      return;
    }
    closeMenu();
    state.fileTarget = transfer;
    $('fileAskName').textContent = transfer.name;
    $('fileAskMeta').textContent = `${transfer.size || ''} · ${transfer.dir === 'in' ? '收到' : '发出'} · ${transfer.time || ''}`;
    $('fileAskPath').textContent = transfer.path;
    $('fileModal').hidden = false;
  }

  function closeFileConfirm() {
    $('fileModal').hidden = true;
    state.fileTarget = null;
  }

  function runFileAction(action) {
    const target = state.fileTarget;
    if (!target || !target.path) return closeFileConfirm();
    closeFileConfirm();
    if (action === 'open') post({ t: 'open-file', path: target.path });
    if (action === 'reveal') post({ t: 'reveal', path: target.path });
    if (action === 'save-as') {
      post({ t: 'copy-file-as', path: target.path, name: target.name });
      toast('选择要保存的位置');
    }
  }

  /* ---------- 通用确认 ---------- */

  let confirmAction = null;

  function askConfirm({
    kicker = '确认',
    title,
    desc = '',
    okText = '确定',
    cancelText = '取消',
    danger = false,
    onOk,
  }) {
    closeMenu();
    confirmAction = onOk || null;
    $('confirmKicker').textContent = kicker;
    $('confirmTitle').textContent = title || '确定要这样做吗';
    $('confirmDesc').textContent = desc;
    $('confirmDesc').hidden = !desc;
    $('confirmOk').textContent = okText;
    $('confirmCancel').textContent = cancelText;
    $('confirmOk').classList.toggle('danger', danger);
    $('confirmOk').classList.toggle('primary', !danger);
    $('confirmModal').hidden = false;
  }

  function closeConfirm(confirmed) {
    if ($('confirmModal').hidden) return;
    $('confirmModal').hidden = true;
    const action = confirmAction;
    confirmAction = null;
    if (confirmed && action) action();
  }

  /* ---------- 配对确认 ---------- */

  function showPairAsk(message) {
    state.pairAsk = message;
    $('pairAskName').textContent = message.name || '未知设备';
    const sas = String(message.sas || '');
    $('pairAskSas').textContent = sas.length === 6 ? `${sas.slice(0, 3)} ${sas.slice(3)}` : sas;
    $('pairModal').hidden = false;
  }

  function closePairAsk(accepted) {
    if ($('pairModal').hidden) return;
    $('pairModal').hidden = true;
    state.pairAsk = null;
    post({ t: 'pair-reply', accepted: Boolean(accepted) });
    toast(accepted ? '已添加设备' : '已拒绝这次配对');
  }

  // ---------- 发送 ----------

  function renderTargets() {
    const box = $('targets');
    box.innerHTML = '';
    if (real) {
      const connected = state.conn === 'connected';
      const devices = knownDevices();
      if (connected) {
        // 已经连着谁就只显示谁，别让人以为能同时发给好几台
        const button = el('button', 'target');
        button.setAttribute('aria-checked', 'true');
        button.append(
          el('span', 'radio'),
          el('span', 'target-name', state.peerName || '对方'),
          el('span', 'target-sub', '已连接'),
        );
        box.append(button);
      } else if (devices.length) {
        for (const device of devices) {
          const button = el('button', `target${device.online ? '' : ' offline'}`);
          button.setAttribute('aria-checked', String(device.id === state.targetId));
          button.append(
            el('span', 'radio'),
            el('span', 'target-name', device.name),
            el('span', 'target-sub', device.online ? '在线 · 点一下连' : '对方离线 · 点一下试试'),
          );
          button.addEventListener('click', () => {
            state.targetId = device.id;
            connectContact(device);
          });
          box.append(button);
        }
      } else {
        const button = el('button', 'target offline');
        button.setAttribute('aria-checked', 'true');
        button.append(
          el('span', 'radio'),
          el('span', 'target-name', '还没有配对设备'),
          el('span', 'target-sub', '先配对再发送'),
        );
        button.addEventListener('click', () => {
          state.pendingSend = Boolean(state.picked);
          showView('pair');
          setTimeout(() => $('pairCode').focus(), 60);
        });
        box.append(button);
      }
      $('sendGo').disabled = !connected;
      return;
    }
    for (const device of state.devices) {
      const button = el('button', `target${device.online ? '' : ' offline'}`);
      button.setAttribute('aria-checked', String(device.name === state.target));
      button.append(
        el('span', 'radio'),
        el('span', 'target-name', device.name),
        el('span', 'target-sub', device.online ? '在线' : '对方离线'),
      );
      button.addEventListener('click', () => {
        state.target = device.name;
        renderTargets();
      });
      box.append(button);
    }
    const linkButton = el('button', 'target');
    linkButton.setAttribute('aria-checked', 'false');
    const arrow = el('span', 'link-ic');
    arrow.innerHTML =
      '<svg viewBox="0 0 16 16"><path d="M6.5 9.5 9.5 6.5"/><path d="M9 3.5 10 2.5a2.5 2.5 0 0 1 3.5 3.5l-1 1"/><path d="M7 12.5l-1 1A2.5 2.5 0 0 1 2.5 10l1-1"/></svg>';
    linkButton.append(arrow, el('span', 'target-name', '生成链接'), el('span', 'target-sub', '对方打开就能取'));
    linkButton.addEventListener('click', () => {
      showView('link');
      makeLink();
    });
    box.append(linkButton);
    $('sendGo').disabled = !currentDevice().online;
  }

  function showSend(items, total, intent) {
    state.picked = { items, total };
    $('pickedName').textContent = items.length === 1 ? items[0].name : `${items[0].name} 等 ${items.length} 个文件`;
    $('pickedMeta').textContent = `共 ${items.length} 项 · ${total}`;
    renderTargets();
    if (intent === 'link') {
      showView('link');
      makeLink();
    } else if (real && state.conn !== 'connected') {
      // 文件已经选好了，先把连接走完；连上之后自动发出去，别让人再选一遍。
      state.pendingSend = true;
      if (knownDevices().length) {
        if (!state.targetId) state.targetId = knownDevices()[0].id;
        showView('send');
        renderTargets();
        toast('点一台设备连上，文件会自动发送');
      } else {
        showView('pair');
        setTimeout(() => $('pairCode').focus(), 60);
        toast('先配对，连上后会自动发送');
      }
    } else {
      showView('send');
    }
  }

  /** 真实模式下把已经选好的文件发出去。 */
  function sendPickedFiles() {
    if (!state.picked) return;
    const paths = state.picked.items.map((item) => item.path).filter(Boolean);
    if (!paths.length) {
      toast('这些文件没有本地路径，换一个再试');
      return;
    }
    post({ t: 'send-files', paths });
    state.pendingSend = false;
    state.tab = 'files';
    showView('home');
    toast(`正在发送 ${paths.length} 个文件`);
  }

  function sendPending() {
    if (!state.pendingSend || !state.picked || state.conn !== 'connected') return;
    sendPickedFiles();
  }

  function doSend() {
    const device = currentDevice();
    if (!state.picked) return;
    if (real) {
      if (state.conn !== 'connected') {
        const device = currentDevice();
        state.pendingSend = true;
        if (device.id) {
          connectContact(device);
          return;
        }
        showView('pair');
        setTimeout(() => $('pairCode').focus(), 60);
        toast('先配对，连上后会自动发送');
        return;
      }
      sendPickedFiles();
      return;
    }
    if (!device.online) return;
    const first = state.picked.items[0];
    const row = {
      device: device.name,
      name: first.name,
      size: state.picked.total,
      dir: 'out',
      status: 'active',
      progress: 3,
      time: '正在发送',
      path: first.path || '',
    };
    state.transfers.unshift(row);
    state.tab = 'files';
    showView('home');
    render();
    post({ t: 'busy', on: true });
    toast(`正在发送给 ${device.name}`);
    const timer = setInterval(() => {
      row.progress = Math.min(100, (row.progress || 0) + 7 + Math.random() * 11);
      if (row.progress >= 100) {
        row.progress = 100;
        row.status = 'done';
        row.time = '刚刚';
        clearInterval(timer);
        updateBusy();
        toast(`已发送给 ${device.name}`);
      }
      renderFiles();
      }, 320);
  }

  // ---------- 链接 ----------

  function expiryText(expiresAt) {
    const left = (expiresAt || 0) - Date.now();
    if (left <= 0) return '已过期';
    if (left >= 3600000) return `${Math.floor(left / 3600000)} 小时内有效`;
    return `${Math.max(1, Math.ceil(left / 60000))} 分钟内有效`;
  }

  /** 真实模式：选文件、挂链接；示例模式：走原来的假数据动画。 */
  function startShare() {
    if (!real) {
      showView('link');
      makeLink();
      return;
    }
    state.link = '';
    $('linkMark').textContent = '…';
    $('linkTitle').textContent = '正在生成链接';
    $('linkDesc').textContent = '选好文件后，把链接发给对方就能取。';
    $('linkText').textContent = '';
    $('copyLink').disabled = true;
    showView('link');
    post({ t: 'pick-share-file' });
  }

  function makeLink() {
    const url = `https://p2p-share-web.pages.dev/s/${Math.random().toString(36).slice(2, 10)}`;
    const finish = () => {
      state.link = url;
      $('linkText').textContent = url;
      $('linkMark').textContent = '✓';
      $('linkTitle').textContent = '链接已复制';
      $('linkDesc').textContent = '发给对方，打开就能取到这份文件。';
      $('copyLink').disabled = false;
      post({ t: 'copy', text: url });
      if (state.picked) {
        state.shares.unshift({
          name: state.picked.items[0].name,
          size: state.picked.total,
          time: '刚刚',
          downloads: 0,
          link: url,
        });
        renderFiles();
      }
    };
    if (shot) {
      finish();
      return;
    }
    state.link = '';
    $('linkMark').textContent = '↑';
    $('linkTitle').textContent = '正在生成链接';
    $('linkDesc').textContent = '把文件放上去，马上就好。';
    $('linkText').textContent = '';
    $('copyLink').disabled = true;
    setTimeout(finish, 700);
  }

  // ---------- 剪贴板同步按钮 ----------

  /** 只同步文字：把本机剪贴板贴到对方。记录页只展示对方发来的内容。 */
  function pushToDevice() {
    const device = currentDevice();
    if (real) {
      if (state.conn !== 'connected') {
        toast('先在「添加设备」里配对，连上后再粘贴');
        return;
      }
      // 内容和提示都交给原生：它会现读剪贴板，空的时候自己会说话。
      post({ t: 'send-text', fromClip: true });
      return;
    }
    if (!device.online) {
      toast(`${device.name} 当前离线`);
      return;
    }
    const text = state.myClip || '（示例）刚从这台设备复制的内容';
    toast(`已同步到 ${device.name}`);
  }

  // ---------- 原生消息 ----------

  function onNative(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.t) {
      case 'init':
        state.savePath = message.savePath || '';
        state.deviceName = message.deviceName || '这台电脑';
        applySettings(message);
        if (real) {
          state.devices = [{ name: state.deviceName, online: false }];
          // 不清 transfers/shares/clips：init 之前到达的快照要保留，
          // 页面刚打开时它们本来就是空的。
          state.target = state.deviceName;
          updateSendButton();
          render();
          if (forcedState) applyForcedState(forcedState);
          break;
        }
        state.devices = message.devices && message.devices.length ? message.devices : MOCK.devices;
        // 原生给的示例记录属于第一台设备；第二台设备的记录用 mock 补上，
        // 这样切换设备时能看到记录确实跟着换了
        const firstDevice = state.devices[0].name;
        const nativeTransfers = (message.transfers || []).map((item) => ({
          ...item,
          device: item.device || firstDevice,
        }));
        state.transfers = [
          ...nativeTransfers,
          ...MOCK.transfers.filter((item) => item.device !== firstDevice),
        ];
        state.clips = MOCK.clips.slice();
        state.shares = MOCK.shares.map((item) => ({ ...item }));
        state.target = state.devices.find((item) => item.online)?.name || state.devices[0].name;
        updateSendButton();
        render();
        if (forcedState) applyForcedState(forcedState);
        break;
      case 'shown': {
        showView('home');
        state.clipFiles = [];
        updateSendButton();
        // 只记下来用于"粘贴给对方"，不把它混进对方发来的记录里
        state.myClip = message.clip || '';
        render();
        if (message.highlight === 'save-path') flashBanner();
        break;
      }
      case 'state': {
        // 这一路同时承载两种消息：会话状态（有 value）和设置回执（只有 savePath/deviceName）。
        // 以前写成两个重复的 case，后一个永远走不到，选完保存位置页面还一直显示"还没设置"。
        if (typeof message.value === 'string') {
          state.conn = message.value || 'idle';
          state.connDetail = message.detail || '';
          if (state.conn === 'connected') {
            state.peerName = state.peerName || '对方';
            state.target = state.peerName;
            if (state.peerId) state.targetId = state.peerId;
            if (state.view === 'pair') {
              showView('home');
              toast(`已连上 ${state.peerName}`);
            }
            sendPending();
          }
          if (state.conn === 'ready' || state.conn === 'offline' || state.conn === 'stopped') {
            // 连接已经没了；通讯录里的设备还在，等对方上线或用户点一下
            state.peerId = '';
            if ((state.conn === 'ready' || state.conn === 'offline') && state.connDetail && state.view === 'home') {
              toast(state.connDetail);
            }
          }
          if (state.conn === 'stopped') state.peerName = '';
          if (state.conn === 'error' && state.connDetail) toast(state.connDetail);
          if (state.conn !== 'connected') {
            // 连接断了，正在传的行不能永远停在"发送中"
            let changed = false;
            for (const transfer of state.transfers) {
              if (transfer.status !== 'active') continue;
              transfer.status = 'error';
              transfer.note = state.conn === 'offline' ? '对方离线' : '连接断了';
              changed = true;
            }
            if (changed) {
              renderFiles();
              updateBusy();
            }
          }
          renderHeader();
          renderTargets();
        }
        if (typeof message.savePath === 'string') state.savePath = message.savePath;
        if (message.deviceName) {
          state.deviceName = message.deviceName;
          const input = $('setDeviceName');
          if (input && document.activeElement !== input) input.value = state.deviceName;
          if (state.pendingDeviceName) {
            if (state.pendingDeviceName === message.deviceName) toast('名字已保存');
            state.pendingDeviceName = '';
          }
        }
        applySettings(message);
        renderHeader();
        renderBanner();
        break;
      }
      case 'open-settings': {
        renderSettings();
        showView('settings');
        break;
      }
      case 'pair-ask': {
        showPairAsk(message);
        break;
      }
      case 'pair-ask-cancel': {
        if (state.pairAsk) {
          $('pairModal').hidden = true;
          state.pairAsk = null;
        }
        break;
      }
      case 'pair-ask-timeout': {
        if (state.pairAsk) {
          $('pairModal').hidden = true;
          state.pairAsk = null;
          toast('配对请求超时了');
        }
        break;
      }
      case 'code': {
        state.code = message.code || '';
        state.pairLink = message.link || '';
        renderPairCode();
        toast(`配对码 ${state.code}`);
        break;
      }
      case 'peer': {
        state.peerId = message.id || '';
        state.peerName = message.name || '对方';
        state.conn = 'connected';
        state.showMyCode = false;
        renderPairCode();
        if (state.pairAsk) {
          $('pairModal').hidden = true;
          state.pairAsk = null;
        }
        if (state.peerId) state.targetId = state.peerId;
        renderHeader();
        renderTargets();
        break;
      }
      case 'contacts': {
        state.contacts = message.items || [];
        if (!state.targetId && state.contacts.length) state.targetId = state.contacts[0].id;
        renderContacts();
        renderTargets();
        break;
      }
      case 'contact-renamed': {
        toast(message.ok ? '已改名' : '改名没生效，还是用原来的名字');
        break;
      }
      case 'presence': {
        state.presence = message.items || [];
        renderHeader();
        renderTargets();
        break;
      }
      case 'history': {
        applyHistory(message);
        break;
      }
      case 'progress': {
        applyProgress(message);
        break;
      }
      case 'text': {
        const text = message.text || '';
        if (text) {
          state.clips.unshift({
            device: state.peerName || '对方',
            peer: state.peerName || '对方',
            text,
            meta: `来自 ${state.peerName || '对方'} · 刚刚`,
          });
          renderClips();
          if (message.autoCopy) {
            post({ t: 'copy', text });
            toast('收到一段文字，已放进剪贴板');
          } else {
            toast('收到一段文字，点记录可以复制');
          }
        }
        break;
      }
      case 'sent': {
        // send_file 返回 true 表示对方已经回了一个覆盖全文件的确认，不是"刚丢出去"。
        toast('已送达 · 对方确认收齐');
        break;
      }
      case 'file-done': {
        const saved = (message.path || '').split(/[\\/]/).pop();
        toast(saved ? `收到 ${saved}，已保存` : '收到一个文件');
        break;
      }
      case 'canceled': {
        const row = state.transfers.find(
          (item) =>
            item.status === 'active' &&
            (item.id === message.id || (!item.id && item.name === message.name)),
        );
        if (row) {
          row.status = 'canceled';
          // docs/36：原生端会把取消原因翻成整句放在 message 里，优先显示它；
          // 旧版本不带 message，退回默认的「已取消」。
          row.note = message.message || '';
          renderFiles();
          updateBusy();
        }
        toast(message.incoming ? '对方取消了这次传输' : '已取消传输');
        break;
      }
      case 'clipboard-files': {
        state.clipFiles = message.items || [];
        updateSendButton();
        break;
      }
      case 'shares': {
        state.shares = (message.items || []).map((item) => ({
          token: item.token,
          link: item.link,
          name: item.name,
          size: humanish(item.bytes || 0),
          time: expiryText(item.expiresAt),
          downloads: item.downloads || 0,
          phase: item.phase || 'idle',
          expiresAt: item.expiresAt,
        }));
        renderFiles();
        break;
      }
      case 'share-created': {
        state.link = message.link || '';
        $('linkMark').textContent = '✓';
        $('linkTitle').textContent = '链接已复制';
        $('linkDesc').textContent = `${message.name || '文件'} · 打开链接就能取。`;
        $('linkText').textContent = state.link;
        $('copyLink').disabled = !state.link;
        if (state.link) post({ t: 'copy', text: state.link });
        break;
      }
      case 'share-cancelled': {
        showView('home');
        break;
      }
      case 'files':
        showSend(message.items || [], message.total || '', message.intent || 'send');
        break;
      case 'toast':
        toast(message.text || '');
        break;
      default:
        break;
    }
  }

  function flashBanner() {
    const banner = $('saveBanner');
    banner.hidden = false;
    banner.classList.remove('flash');
    void banner.offsetWidth;
    banner.classList.add('flash');
  }

  // ---------- 截图 / 单独预览 ----------

  function applyForcedState(name) {
    if (name === 'send') {
      showSend(
        [
          { name: '会议纪要-10月.txt', size: '2.4 KB', path: '' },
          { name: '产品图标.png', size: '22.1 KB', path: '' },
        ],
        '24.5 KB',
        'send',
      );
    } else if (name === 'link') {
      showSend([{ name: '产品演示.mp4', size: '68.2 MB', path: '' }], '68.2 MB', 'link');
    } else if (name === 'clipfiles') {
      state.clipFiles = [
        { name: '季度报告.pdf', path: '', bytes: 12 * 1024 * 1024, size: '12.0 MB' },
        { name: '现场照片.jpg', path: '', bytes: 3 * 1024 * 1024, size: '3.0 MB' },
      ];
      updateSendButton();
      showView('home');
      render();
    } else if (name === 'clipimage') {
      state.clipFiles = [
        {
          name: '截图 2026-10-20 03-52-44.png',
          path: '',
          bytes: 1250,
          size: '1.2 KB',
          kind: 'image',
        },
      ];
      updateSendButton();
      showView('home');
      render();
    } else if (name === 'pair') {
      showView('pair');
    } else if (name === 'files') {
      state.tab = 'files';
      showView('home');
      render();
    } else if (name === 'devices') {
      showView('home');
      render();
      openDeviceMenu();
    } else if (name === 'setup') {
      state.savePath = '';
      showView('home');
      render();
      flashBanner();
    } else {
      showView('home');
    }
  }

  // ---------- 事件 ----------

  /**
   * 切换主题：和网页端同一套做法——浏览器拍前后两张快照，给其中一张加圆形裁切。
   * 换成另一套主题时新的一层从按钮往外扩散；切回打开时的主题时朝按钮收回去。
   */
  function toggleTheme() {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || vtBusy || reduce) {
      currentTheme = next;
      rootEl.dataset.theme = next;
      return;
    }

    const rect = $('themeBtn').getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const retract = next === initialTheme;

    rootEl.classList.add(retract ? 'vt-retract' : 'vt-spread');
    vtBusy = true;
    const transition = document.startViewTransition(() => {
      currentTheme = next;
      rootEl.dataset.theme = next;
    });

    let animation = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (animation) animation.cancel();
      animation = null;
      rootEl.classList.remove('vt-retract', 'vt-spread');
      vtBusy = false;
    };

    transition.ready
      .then(() => {
        const pseudo = retract ? '::view-transition-old(root)' : '::view-transition-new(root)';
        const from = retract ? `circle(${radius}px at ${x}px ${y}px)` : `circle(0px at ${x}px ${y}px)`;
        const to = retract ? `circle(0px at ${x}px ${y}px)` : `circle(${radius}px at ${x}px ${y}px)`;
        animation = rootEl.animate([{ clipPath: from }, { clipPath: to }], {
          duration: 520,
          // 收回用同一条曲线的时间反演，看起来就是扩散倒放
          easing: retract ? 'cubic-bezier(0.8, 0, 0.8, 0.2)' : 'cubic-bezier(0.2, 0.8, 0.2, 1)',
          pseudoElement: pseudo,
          // 留住最后一帧，否则动画结束到快照移除之间会闪一下
          fill: 'forwards',
        });
      })
      .catch(() => {});

    transition.finished.then(cleanup).catch(cleanup);
    setTimeout(cleanup, 1600);
  }

  function wire() {
    $('deviceBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      openDeviceMenu();
    });
    $('addDeviceBtn').addEventListener('click', () => {
      state.showMyCode = false;
      renderPairCode();
      showView('pair');
      setTimeout(() => $('pairCode').focus(), 60);
    });
    $('themeBtn').addEventListener('click', toggleTheme);
    $('settingsBtn').addEventListener('click', () => {
      renderSettings();
      showView('settings');
    });
    $('setSavePath').addEventListener('click', () => post({ t: 'pick-save-path' }));
    $('setSound').addEventListener('change', () => {
      state.notifySound = $('setSound').value;
      post({ t: 'set-notify-sound', name: state.notifySound });
    });
    $('setAutosync').addEventListener('change', () => {
      state.autosync = $('setAutosync').checked;
      post({ t: 'set-sync', on: state.autosync });
    });
    $('setAutostart').addEventListener('change', () => {
      state.autostart = $('setAutostart').checked;
      post({ t: 'set-autostart', on: state.autostart });
    });
    $('setSendto').addEventListener('change', () => {
      state.sendto = $('setSendto').checked;
      post({ t: 'set-sendto', on: state.sendto });
    });
    $('setDeviceNameSave').addEventListener('click', saveDeviceName);
    $('setDeviceName').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveDeviceName();
    });
    $('setOpenFull').addEventListener('click', () => post({ t: 'open-full-ui' }));
    $('collapseBtn').addEventListener('click', () => post({ t: 'close' }));
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => setTab(tab.dataset.tab));
    }
    $('pickFiles').addEventListener('click', () => {
      if (!isConnected()) {
        startShare();
        return;
      }
      if (state.clipFiles.length) {
        const total = state.clipFiles.reduce((sum, item) => sum + (item.bytes || 0), 0);
        showSend(state.clipFiles, humanish(total), 'send');
        return;
      }
      if (bridge) {
        post({ t: 'pick-files' });
      } else {
        showSend(
          [
            { name: '会议纪要-10月.txt', size: '2.4 KB', path: '' },
            { name: '产品图标.png', size: '22.1 KB', path: '' },
          ],
          '24.5 KB',
          'send',
        );
      }
    });
    $('pickMenu').addEventListener('click', (event) => {
      event.stopPropagation();
      openMenuAt($('pickMenu'), (menu) => {
        const send = el('button');
        send.append(
          el('span', null, '发送给设备…'),
          el('span', 'sub', isConnected() ? '选文件后连设备' : '先配对'),
        );
        send.disabled = !isConnected();
        send.addEventListener('click', () => {
          closeMenu();
          post({ t: 'pick-files' });
        });
        const link = el('button');
        link.append(el('span', null, '创建分享链接…'), el('span', 'sub', '对方打开就能取'));
        link.addEventListener('click', () => {
          closeMenu();
          startShare();
        });
        menu.append(send, link);
        if (state.clipFiles.length) {
          const clip = el('button');
          clip.append(
            el('span', null, '发送剪贴板里的文件'),
            el('span', 'sub', `${state.clipFiles.length} 个`),
          );
          clip.addEventListener('click', () => {
            closeMenu();
            const total = state.clipFiles.reduce((sum, item) => sum + (item.bytes || 0), 0);
            showSend(state.clipFiles, humanish(total), 'send');
          });
          menu.append(clip);
        }
      });
    });
    $('sendGo').addEventListener('click', doSend);
    $('linkDone').addEventListener('click', () => showView('home'));
    $('copyLink').addEventListener('click', () => {
      if (!state.link) return;
      post({ t: 'copy', text: state.link });
      toast('已复制');
    });
    for (const body of document.querySelectorAll('.group-body, .settings-body, .view')) {
      body.addEventListener('scroll', refreshFades);
    }

    // 分组折叠
    for (const header of document.querySelectorAll('.group-hd')) {
      header.addEventListener('click', () => {
        const group = header.parentElement;
        group.classList.toggle('collapsed');
        const collapsed = group.classList.contains('collapsed');
        group.style.flex = collapsed ? '0 0 34px' : '1 1 0';
        $('splitter').hidden = document.querySelector('.group.collapsed') !== null;
      });
    }

    // 拖动分组边界
    $('splitter').addEventListener('pointerdown', (event) => {
      const direct = $('groupDirect');
      const shares = $('groupShares');
      if (direct.classList.contains('collapsed') || shares.classList.contains('collapsed')) return;
      const startY = event.clientY;
      const startHeight = direct.getBoundingClientRect().height;
      const container = $('fileList').getBoundingClientRect().height;
      const maxHeight = container - 34 - 10;
      const splitter = $('splitter');
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('dragging');
      document.body.classList.add('dragging');
      const onMove = (moveEvent) => {
        const height = Math.min(Math.max(34, startHeight + moveEvent.clientY - startY), maxHeight);
        direct.style.flex = `0 0 ${height}px`;
        shares.style.flex = '1 1 0';
      };
      const onUp = () => {
        splitter.classList.remove('dragging');
        document.body.classList.remove('dragging');
        splitter.removeEventListener('pointermove', onMove);
        splitter.removeEventListener('pointerup', onUp);
        refreshFades();
      };
      splitter.addEventListener('pointermove', onMove);
      splitter.addEventListener('pointerup', onUp);
    });

    $('pairGo').addEventListener('click', () => {
      const code = $('pairCode').value.trim();
      if (!code) {
        toast('先输入对方屏幕上的六位数字');
        return;
      }
      if (real) {
        stopAdvertising();
        post({ t: 'join', code });
        toast('正在连接…');
        showView('home');
      } else {
        toast('示例里还没接配对流程');
      }
    });
    $('pairScan').addEventListener('click', () => {
      if (real) {
        state.showMyCode = true;
        renderPairCode();
        post({ t: 'advertise' });
        toast('正在向灯塔要配对码…');
      } else {
        toast('示例里还没接配对流程');
      }
    });
    $('backToInput').addEventListener('click', () => {
      stopAdvertising();
      setTimeout(() => $('pairCode').focus(), 60);
    });
    $('pairCam').addEventListener('click', () => {
      openScan();
    });
    $('scanPick').addEventListener('click', () => $('scanFile').click());
    $('scanFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) decodeScanFile(file);
    });
    $('copyPairLink').addEventListener('click', () => {
      if (!state.pairLink) return;
      post({ t: 'copy', text: state.pairLink });
      toast('配对链接已复制');
    });
    $('pairCode').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('pairGo').click();
    });
    $('pushClip').addEventListener('click', pushToDevice);
    $('pairAccept').addEventListener('click', () => closePairAsk(true));
    $('pairReject').addEventListener('click', () => closePairAsk(false));
    $('pairModal').addEventListener('click', (event) => {
      if (event.target === $('pairModal')) closePairAsk(false);
    });
    $('fileOpen').addEventListener('click', () => runFileAction('open'));
    $('fileReveal').addEventListener('click', () => runFileAction('reveal'));
    $('fileSaveAs').addEventListener('click', () => runFileAction('save-as'));
    $('fileCancel').addEventListener('click', closeFileConfirm);
    $('fileModal').addEventListener('click', (event) => {
      if (event.target === $('fileModal')) closeFileConfirm();
    });
    $('confirmOk').addEventListener('click', () => closeConfirm(true));
    $('confirmCancel').addEventListener('click', () => closeConfirm(false));
    $('confirmModal').addEventListener('click', (event) => {
      if (event.target === $('confirmModal')) closeConfirm(false);
    });
    $('saveBanner').addEventListener('click', () => {
      if (bridge) {
        post({ t: 'pick-save-path' });
      } else {
        state.savePath = 'C:\\Users\\Public\\Downloads\\在线互传';
        renderBanner();
        toast('保存位置已设置');
      }
    });
    // 扫码是一层子页：返回要回到「添加设备」，不是直接回首页
    for (const button of document.querySelectorAll('[data-back]')) {
      button.addEventListener('click', goBack);
    }
    document.addEventListener('click', () => closeMenu());
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!$('pairModal').hidden) {
        closePairAsk(false);
      } else if (!$('fileModal').hidden) {
        closeFileConfirm();
      } else if (!$('confirmModal').hidden) {
        closeConfirm(false);
      } else if (!$('popmenu').hidden) {
        closeMenu();
      } else if (state.view !== 'home') {
        goBack();
      } else {
        post({ t: 'close' });
      }
    });
    window.addEventListener('blur', () => closeMenu());
  }

  // ---------- 启动 ----------

  wire();
  if (bridge) {
    bridge.addEventListener('message', (event) => onNative(event.data));
    bridge.postMessage({ t: 'ready' });
  } else {
    state.savePath = forcedState === 'setup' ? '' : 'C:\\Users\\Public\\Downloads\\在线互传';
    state.devices = MOCK.devices.map((item) => ({ ...item }));
    state.transfers = MOCK.transfers.map((item) => ({ ...item }));
    state.clips = MOCK.clips.map((item) => ({ ...item }));
    state.shares = MOCK.shares.map((item) => ({ ...item }));
    state.target = '办公室电脑';
    render();
    if (forcedState) applyForcedState(forcedState);
  }
})();
