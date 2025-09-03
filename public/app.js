// CrossSync - 客户端JavaScript
class FileTransferApp {
    constructor() {
        this.socket = null;
        this.deviceId = null;
        this.roomId = null;
        this.peerConnections = new Map();
        this.dataChannels = new Map();
        this.connectedDevices = new Map(); // 存储连接设备信息
        this.receivingFiles = new Map(); // 存储正在接收的文件信�?(fileId -> fileInfo)
        this.fileTransferQueue = []; // 文件传输队列
        this.isHost = false;
        this.wakeLock = null; // 防止手机睡眠
        this.isTransferring = false; // 全局传输状�?
        this.connectionMonitor = null; // 连接监控定时�?
        this.reconnectAttempts = 0; // 重连尝试次数
        this.maxReconnectAttempts = 5; // 最大重连次�?
        this.transferState = new Map(); // 保存传输状态以便恢�?
        this.keepAliveInterval = null; // 保活心跳
        this.deviceRegistered = false; // 设备是否已在服务端登�?
        this.hasAttemptedRoomFlow = false; // 是否已尝试创�?加入房间
        this.urlRoomParam = null; // URL中携带的房间参数
        this.shouldRejoinRoom = false; // 断线后是否应恢复房间
        
        // WebRTC配置
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };
        
        this.init();
    }
    
    async init() {
        // 初始化Socket连接
        this.initSocket();
        
        // 绑定事件监听�?
        this.bindEvents();
        
        // 读取URL参数（房间ID），实际触发在设备注册后
        this.checkUrlParams();
        
        // 检测设备信�?
        this.detectDevice();
        
        // 初始化防睡眠机制
        this.initWakeLock();
        
        // 监听页面可见性变�?
        this.initVisibilityHandler();
        
        // 请求通知权限
        this.requestNotificationPermission();
        
        // 初始化PWA支持
        this.initPWA();
        
        // 启动保活机制
        this.startKeepAlive();
    }
    
    initSocket() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('已连接到服务�?);
            this.reconnectAttempts = 0; // 重置重连计数
            
            // 移除重连提示
            const reconnectNotification = document.getElementById('reconnectingNotification');
            if (reconnectNotification) {
                reconnectNotification.remove();
            }
            
            // 暂时不隐藏重连按钮，等到有设备连接时再隐�?
            console.log('已连接到服务器，但先保持重连按钮可见');
            
            this.registerDevice();
            
            // 尝试恢复传输状�?
            this.restoreTransferState();
            // UI: 更新连接与设备状�?
            try {
                this.updateConnectionStatus('已连接到服务�?, 'connected');
                const ds = document.getElementById('deviceStatus');
                if (ds) {
                    ds.textContent = '在线';
                    ds.className = 'device-status online';
                }
            } catch (e) { /* noop */ }
        });
        
        // 心跳响应
        this.socket.on('pong', () => {
            console.log('收到服务器心跳响�?);
        });
        
        this.socket.on('disconnect', () => {
            console.log('与服务器断开连接');
            this.updateConnectionStatus('连接断开');
            
            // 显示重连按钮（无论是否在传输�?
            console.log('断开连接事件触发，准备显示重连按�?);
            this.showReconnectControls();
            try {
                this.updateConnectionStatus('连接断开', 'offline');
                const ds = document.getElementById('deviceStatus');
                if (ds) {
                    ds.textContent = '离线';
                    ds.className = 'device-status offline';
                }
            } catch (e) { /* noop */ }
            
            // 强制显示重连按钮（防止被其他逻辑隐藏�?
            setTimeout(() => {
                console.log('延迟强制显示重连按钮');
                this.showReconnectControls();
            }, 100);
            
            // 如果正在传输，处理连接中�?
            if (this.isTransferring) {
                this.handleConnectionLost();
            }
        });
        
        this.socket.on('device-registered', (data) => {
            this.deviceId = data.deviceId;
            this.updateDeviceInfo(data.deviceInfo);
            console.log('设备已注�?', data.deviceInfo);
            this.deviceRegistered = true;
            // 注册完成后再尝试创建/加入房间，避免竞�?
            this.maybeStartRoomFlow();
        });
        
        this.socket.on('room-created', (data) => {
            this.roomId = data.roomId;
            this.isHost = true;
            this.updateRoomId(data.roomId);
            this.updateUrlWithRoomId(data.roomId);
            this.generateQRCodeUI(data.roomId);
            this.showDevicesList();
        });
        
        this.socket.on('room-joined', (data) => {
            this.roomId = data.roomId;
            this.updateRoomId(data.roomId);
            this.updateUrlWithRoomId(data.roomId);
            this.showDevicesList();
            this.hideQRCode();
        });
        
        this.socket.on('room-devices-updated', (data) => {
            this.updateDevicesList(data.devices);
        });
        
        this.socket.on('webrtc-offer', async (data) => {
            await this.handleWebRTCOffer(data);
        });
        
        this.socket.on('webrtc-answer', async (data) => {
            await this.handleWebRTCAnswer(data);
        });
        
        this.socket.on('webrtc-ice-candidate', async (data) => {
            await this.handleICECandidate(data);
        });
        
        this.socket.on('file-transfer-start', (data) => {
            this.handleFileTransferStart(data);
        });
        
        this.socket.on('file-transfer-progress', (data) => {
            this.handleFileTransferProgress(data);
        });
        
        this.socket.on('file-transfer-complete', (data) => {
            this.handleFileTransferComplete(data);
        });
        
        this.socket.on('error', (data) => {
            console.error('Socket错误:', data.message);
            this.showError(data.message);
            
            // 连接错误时也显示重连按钮
            this.showReconnectControls();
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('连接错误:', error);
            this.updateConnectionStatus('连接失败');
            this.showReconnectControls();
        });
    }
    
    bindEvents() {
        // 文件选择
        const fileInput = document.getElementById('fileInput');
        const selectBtn = document.getElementById('selectBtn');
        const uploadArea = document.getElementById('uploadArea');
        
        selectBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        
        // 移动端不需要拖拽功�?
        
        // 帮助和关于按�?
        const helpBtn = document.getElementById('helpBtn');
        const aboutBtn = document.getElementById('aboutBtn');
        const closeHelp = document.getElementById('closeHelp');
        const helpModal = document.getElementById('helpModal');
        
        helpBtn.addEventListener('click', () => helpModal.style.display = 'block');
        aboutBtn.addEventListener('click', () => this.showAbout());
        closeHelp.addEventListener('click', () => helpModal.style.display = 'none');
        
        // 点击模态框背景关闭
        helpModal.addEventListener('click', (e) => {
            if (e.target === helpModal) {
                helpModal.style.display = 'none';
            }
        });

        // 键盘 ESC 关闭帮助
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const hm = document.getElementById('helpModal');
                if (hm && hm.style.display === 'block') {
                    hm.style.display = 'none';
                }
            }
        });

        // 桌面端启用拖拽上�?
        if (uploadArea && !(this.isMobile)) {
            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadArea.classList.add('dragover');
            });
            uploadArea.addEventListener('dragleave', (e) => {
                e.preventDefault();
                uploadArea.classList.remove('dragover');
            });
            uploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                uploadArea.classList.remove('dragover');
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    this.processFiles(e.dataTransfer.files);
                }
            });
        }

        // 点击/回车 上传区域 也可打开文件选择�?
        if (uploadArea) {
            const openPicker = () => fileInput && fileInput.click();
            uploadArea.addEventListener('click', openPicker);
            uploadArea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPicker();
                }
            });
        }
    }
    
    checkUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        this.urlRoomParam = urlParams.get('room');
        // 实际动作等设备注册完成后触发
        this.maybeStartRoomFlow();
    }

    // 更健壮的二维码生成与渲染（清晰文�?+ 备用地址�?
    async generateQRCodeUI(roomId) {
        try {
            const response = await fetch(`/api/qr/${roomId}`);
            const data = await response.json();

            const qrContainer = document.getElementById('qrContainer');
            const urls = [];
            if (data && data.url) urls.push({ url: data.url, recommended: true });
            if (Array.isArray(data.alternativeIPs)) {
                try {
                    const base = new URL(data.url);
                    data.alternativeIPs.forEach(ip => {
                        urls.push({ url: `${base.protocol}//${ip}:${base.port}?room=${roomId}`, recommended: false });
                    });
                } catch (_) {}
            }
            const urlListHtml = urls.map(u => `
                <p>${u.recommended ? '推荐' : '备�?}�?a href="${u.url}" target="_blank" rel="noopener">${u.url}</a></p>
            `).join('');

            qrContainer.innerHTML = `
                <img src="${data.qrCode}" alt="QR Code" style="max-width: 200px;">
                <p style="margin-top: 10px; font-size: 0.9rem; color: #666;">
                    用其他设备扫描此二维码加�?
                </p>
                <div class="address-list" style="margin-top: 15px; font-size: 0.8rem; color: #888; text-align: left;">
                    <p><strong>如果二维码无法访问，请手动输入以下地址之一�?/strong></p>
                    ${urlListHtml}
                    <p style="margin-top: 8px; font-style: italic;">确保手机和电脑连接同一 WiFi 网络</p>
                </div>
            `;

            this.updateConnectionStatus('等待其他设备扫码加入...', 'connecting');
        } catch (error) {
            console.error('生成 QR 码失�?', error);
            this.updateConnectionStatus('QR 码生成失�?, 'offline');
        }
    }

    // 在设备成功注册后再创�?加入房间，避免服务端拒绝
    maybeStartRoomFlow() {
        if (this.hasAttemptedRoomFlow) return;
        if (!this.deviceRegistered) return;

        // 断线恢复优先：有 roomId 则按角色恢复
        if (this.shouldRejoinRoom && this.roomId) {
            this.hasAttemptedRoomFlow = true;
            if (this.isHost) {
                this.socket.emit('create-room', { roomId: this.roomId });
                this.updateConnectionStatus(`正在恢复房间 ${this.roomId}...`, 'connecting');
            } else {
                this.joinRoom(this.roomId);
            }
            return;
        }

        // URL 参数优先加入
        if (this.urlRoomParam) {
            this.hasAttemptedRoomFlow = true;
            this.joinRoom(this.urlRoomParam);
            return;
        }

        // 默认创建
        this.hasAttemptedRoomFlow = true;
        this.createRoom();
    }
    
    detectDevice() {
        const ua = navigator.userAgent.toLowerCase();
        let deviceName = '未知设备';
        let deviceIcon = '📱';
        
        // 检测是否为移动设备
        this.isMobile = /iphone|ipad|ipod|android|mobile/.test(ua) || 
                        ('ontouchstart' in window) || 
                        (window.innerWidth <= 768);
        
        if (/iphone|ipad|ipod/.test(ua)) {
            deviceName = /ipad/.test(ua) ? 'iPad' : 'iPhone';
            deviceIcon = '📱';
        } else if (/android/.test(ua)) {
            deviceName = 'Android设备';
            deviceIcon = '📱';
        } else if (/windows/.test(ua)) {
            deviceName = 'Windows电脑';
            deviceIcon = '💻';
        } else if (/macintosh|mac os x/.test(ua)) {
            deviceName = 'Mac电脑';
            deviceIcon = '💻';
        }
        
        // 为移动设备添加特殊的CSS�?
        if (this.isMobile) {
            document.body.classList.add('mobile-device');
        }
        
        document.querySelector('.device-icon').textContent = deviceIcon;
    }
    
    registerDevice() {
        this.socket.emit('register-device', {
            name: this.getDeviceName()
        });
    }
    
    getDeviceName() {
        const ua = navigator.userAgent.toLowerCase();
        if (/iphone|ipad|ipod/.test(ua)) {
            return /ipad/.test(ua) ? 'iPad' : 'iPhone';
        } else if (/android/.test(ua)) {
            return 'Android设备';
        } else if (/windows/.test(ua)) {
            return 'Windows电脑';
        } else if (/macintosh|mac os x/.test(ua)) {
            return 'Mac电脑';
        }
        return '未知设备';
    }
    
    createRoom() {
        this.socket.emit('create-room');
        this.updateConnectionStatus('创建房间�?..');
    }
    
    joinRoom(roomId) {
        this.socket.emit('join-room', { roomId });
        this.updateConnectionStatus(`加入房间 ${roomId}...`);
    }
    
    async generateQRCode(roomId) {
        try {
            const response = await fetch(`/api/qr/${roomId}`);
            const data = await response.json();
            
            const qrContainer = document.getElementById('qrContainer');
            // 构建动态地址列表
            const urls = [];
            if (data && data.url) {
                urls.push({ url: data.url, recommended: true });
            }
            if (Array.isArray(data.alternativeIPs)) {
                try {
                    const base = new URL(data.url);
                    data.alternativeIPs.forEach(ip => {
                        urls.push({ url: `${base.protocol}//${ip}:${base.port}?room=${roomId}`, recommended: false });
                    });
                } catch (e) {}
            }
            const urlListHtml = urls.map(u => `
                <p>${u.recommended ? '�? : '�?} <a href="${u.url}" target="_blank" rel="noopener">${u.url}</a></p>
            `).join('');
            qrContainer.innerHTML = `
                <img src="${data.qrCode}" alt="QR Code" style="max-width: 200px;">
                <p style="margin-top: 10px; font-size: 0.9rem; color: #666;">
                    用其他设备扫描此二维码加�?
                </p>
                <div class="address-list" style="margin-top: 15px; font-size: 0.8rem; color: #888; text-align: left;">
                    <p><strong>如果二维码无法访问，请手动输入以下地址之一�?/strong></p>
                    ${urlListHtml}
                    <p style="margin-top: 8px; font-style: italic;">确保手机和电脑连接同一WiFi网络</p>
                </div>
            `;
            
            this.updateConnectionStatus('等待其他设备扫码加入...');
        } catch (error) {
            console.error('生成QR码失�?', error);
            this.updateConnectionStatus('QR码生成失�?);
        }
    }
    
    updateDeviceInfo(deviceInfo) {
        document.getElementById('deviceName').textContent = deviceInfo.name;
        document.getElementById('deviceStatus').textContent = '在线';
        document.getElementById('deviceStatus').className = 'device-status online';
    }
    
    updateConnectionStatus(status, state) {
        const el = document.getElementById('connectionStatus');
        if (!el) return;

        // 尝试推断状态（如果未显式传入）
        let inferred = typeof state === 'string' ? state : null;
        if (!inferred) {
            const s = String(status || '');
            if (/(断开|失败|错误)/.test(s)) inferred = 'offline';
            else if (/(已连接|恢复|可以传输)/.test(s)) inferred = 'connected';
            else if (/(创建|加入|等待|正在|重连)/.test(s)) inferred = 'connecting';
        }

        // 更新指示器样�?
        const indicator = document.getElementById('connectionIndicator');
        if (indicator) {
            indicator.classList.remove('connected', 'connecting', 'offline');
            if (inferred === 'connected') indicator.classList.add('connected');
            else if (inferred === 'connecting') indicator.classList.add('connecting');
            else if (inferred === 'offline') indicator.classList.add('offline');
        }

        // 设置文本，同时保留指示器节点
        if (indicator && indicator.parentElement === el) {
            el.innerHTML = '';
            el.appendChild(indicator);
            el.appendChild(document.createTextNode(' ' + (status || '')));
        } else {
            el.textContent = status || '';
        }
    }
    
    updateRoomId(roomId) {
        document.getElementById('roomId').textContent = roomId;
    }

    // 将房间号写入 URL，便于二次访�?分享
    updateUrlWithRoomId(roomId) {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomId);
            window.history.replaceState(null, '', url.toString());
        } catch (e) {
            // ignore
        }
    }

    copyRoomId() {
        try {
            const id = document.getElementById('roomId').textContent.trim();
            if (!id || id === '-') return;
            navigator.clipboard.writeText(id).then(() => {
                this.showToast('房间ID已复�?);
            }).catch(() => {
                this.showToast('复制失败，请手动选择');
            });
        } catch (e) {
            this.showToast('复制失败，请手动选择');
        }
    }

    showToast(message) {
        const n = document.createElement('div');
        n.style.cssText = `position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); color: #fff; padding: 10px 16px; border-radius: 20px; font-size: 14px; z-index: 1100;`;
        n.textContent = message;
        document.body.appendChild(n);
        setTimeout(() => { if (n.parentNode) n.parentNode.removeChild(n); }, 1800);
    }
    
    showDevicesList() {
        document.getElementById('devicesList').style.display = 'block';
        document.getElementById('fileTransfer').style.display = 'block';
    }
    
    // 显示文件传输区域（在建立连接后调用）
    showFileTransfer() {
        const section = document.getElementById('fileTransfer');
        if (section) {
            section.style.display = 'block';
        }
    }
    
    hideQRCode() {
        document.getElementById('qrContainer').innerHTML = '';
        this.updateConnectionStatus('已加入房间，等待连接其他设备...');
    }
    
    updateDevicesList(devices) {
        const container = document.getElementById('devicesContainer');
        container.innerHTML = '';
        
        const otherDevices = [];
        
        devices.forEach(device => {
            if (device.id !== this.deviceId) {
                // 存储设备信息
                this.connectedDevices.set(device.id, device);
                
                const deviceElement = this.createDeviceElement(device);
                container.appendChild(deviceElement);
                
                otherDevices.push(device);
            }
        });
        
        // 如果有设备连接且Socket连接正常
        if (devices.length > 1 && this.socket && this.socket.connected) { // 除了自己还有其他设备且Socket连接正常
            // 检查是否需要重新建立WebRTC连接
            this.checkAndRestoreWebRTCConnections(otherDevices);
            
            // 延迟检查WebRTC连接状态，确保连接真正建立后再隐藏重连按钮
            setTimeout(() => {
                this.verifyConnectionsAndUpdateUI(otherDevices);
            }, 2000);
        }
    }
    
    // 检查并恢复WebRTC连接
    checkAndRestoreWebRTCConnections(devices) {
        console.log('检查WebRTC连接状�?..');
        
        devices.forEach(device => {
            const peerConnection = this.peerConnections.get(device.id);
            const dataChannel = this.dataChannels.get(device.id);
            
            // 如果没有WebRTC连接或连接已断开，重新建立连�?
            if (!peerConnection || 
                peerConnection.connectionState === 'disconnected' || 
                peerConnection.connectionState === 'failed' || 
                !dataChannel || 
                dataChannel.readyState !== 'open') {
                
                console.log(`需要重新建立与设备 ${device.name} 的WebRTC连接`);
                
                // 延迟重新连接，避免竞争条�?
                setTimeout(() => {
                    this.connectToDevice(device.id);
                }, 500 + Math.random() * 1000); // 随机延迟避免同时发起连接
            } else {
                console.log(`与设�?${device.name} 的WebRTC连接正常`);
            }
        });
    }
    
    // 验证连接状态并更新UI
    verifyConnectionsAndUpdateUI(devices) {
        let healthyConnections = 0;
        let totalConnections = devices.length;
        
        devices.forEach(device => {
            const peerConnection = this.peerConnections.get(device.id);
            const dataChannel = this.dataChannels.get(device.id);
            
            if (peerConnection && 
                peerConnection.connectionState === 'connected' &&
                dataChannel && 
                dataChannel.readyState === 'open') {
                healthyConnections++;
            }
        });
        
        console.log(`WebRTC连接状�? ${healthyConnections}/${totalConnections} 连接正常`);
        
        if (healthyConnections > 0) {
            // 有健康的WebRTC连接，隐藏重连按�?
            this.hideReconnectControls();
            this.updateConnectionStatus(`设备已连�?(${healthyConnections}/${totalConnections})，可以传输文件`);
        } else if (totalConnections > 0) {
            // 有设备但WebRTC连接还未建立
            this.updateConnectionStatus('正在建立连接...');
            // 不隐藏重连按钮，给用户手动重连的选项
        }
    }
    
    createDeviceElement(device) {
        const div = document.createElement('div');
        div.className = 'device-item';
        div.innerHTML = `
            <div class="device-item-info">
                <div class="device-item-icon">${device.icon}</div>
                <div>
                    <div class="device-item-name">${device.name}</div>
                    <div class="device-item-status">在线</div>
                </div>
            </div>
            <button class="connect-btn" onclick="app.connectToDevice('${device.id}')">
                连接
            </button>
        `;
        return div;
    }
    
    async connectToDevice(targetId) {
        console.log('连接到设�?', targetId);
        
        try {
            const peerConnection = new RTCPeerConnection(this.rtcConfig);
            this.peerConnections.set(targetId, peerConnection);
            
            // 创建数据通道
            const dataChannel = peerConnection.createDataChannel('fileTransfer', {
                ordered: true
            });
            this.setupDataChannel(dataChannel, targetId);
            this.dataChannels.set(targetId, dataChannel);
            
            // 处理ICE候选�?
            peerConnection.addEventListener('icecandidate', (event) => {
                if (event.candidate) {
                    this.socket.emit('webrtc-ice-candidate', {
                        targetId,
                        candidate: event.candidate
                    });
                }
            });
            
            // 处理连接状态变�?
            peerConnection.addEventListener('connectionstatechange', () => {
                console.log('连接状�?', peerConnection.connectionState);
                if (peerConnection.connectionState === 'connected') {
                    this.onPeerConnected(targetId);
                } else if (peerConnection.connectionState === 'failed' || 
                          peerConnection.connectionState === 'disconnected') {
                    console.warn('WebRTC连接中断:', targetId);
                    if (this.isTransferring) {
                        this.handleConnectionLost();
                    }
                }
            });
            
            // 创建offer
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            
            this.socket.emit('webrtc-offer', {
                targetId,
                offer
            });
            
        } catch (error) {
            console.error('连接设备失败:', error);
            this.showError('连接失败，请重试');
            // 清理失败的连�?
            this.peerConnections.delete(targetId);
            this.dataChannels.delete(targetId);
        }
    }
    
    async handleWebRTCOffer(data) {
        const { sourceId, offer } = data;
        
        try {
            const peerConnection = new RTCPeerConnection(this.rtcConfig);
            this.peerConnections.set(sourceId, peerConnection);
            
            // 处理数据通道
            peerConnection.addEventListener('datachannel', (event) => {
                const dataChannel = event.channel;
                this.setupDataChannel(dataChannel, sourceId);
                this.dataChannels.set(sourceId, dataChannel);
            });
            
            // 处理ICE候选�?
            peerConnection.addEventListener('icecandidate', (event) => {
                if (event.candidate) {
                    this.socket.emit('webrtc-ice-candidate', {
                        targetId: sourceId,
                        candidate: event.candidate
                    });
                }
            });
            
            // 处理连接状态变�?
            peerConnection.addEventListener('connectionstatechange', () => {
                console.log('连接状�?', peerConnection.connectionState);
                if (peerConnection.connectionState === 'connected') {
                    this.onPeerConnected(sourceId);
                }
            });
            
            await peerConnection.setRemoteDescription(offer);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            this.socket.emit('webrtc-answer', {
                targetId: sourceId,
                answer
            });
            
        } catch (error) {
            console.error('处理WebRTC offer失败:', error);
        }
    }
    
    async handleWebRTCAnswer(data) {
        const { sourceId, answer } = data;
        const peerConnection = this.peerConnections.get(sourceId);
        
        if (peerConnection) {
            try {
                await peerConnection.setRemoteDescription(answer);
            } catch (error) {
                console.error('处理WebRTC answer失败:', error);
            }
        }
    }
    
    async handleICECandidate(data) {
        const { sourceId, candidate } = data;
        const peerConnection = this.peerConnections.get(sourceId);
        
        if (peerConnection) {
            try {
                await peerConnection.addIceCandidate(candidate);
            } catch (error) {
                console.error('添加ICE候选者失�?', error);
            }
        }
    }
    
    setupDataChannel(dataChannel, peerId) {
        // 初始化数据通道状�?
        dataChannel._isTransferring = false;
        
        dataChannel.addEventListener('open', () => {
            console.log('数据通道已打开:', peerId);
            dataChannel._isTransferring = false; // 确保状态清�?
        });
        
        dataChannel.addEventListener('close', () => {
            console.log('数据通道已关�?', peerId);
            dataChannel._isTransferring = false; // 清理状�?
        });
        
        dataChannel.addEventListener('error', (error) => {
            console.error('数据通道错误:', error);
            dataChannel._isTransferring = false; // 错误时清理状�?
        });
        
        dataChannel.addEventListener('message', (event) => {
            this.handleDataChannelMessage(event, peerId);
        });
    }
    
    onPeerConnected(peerId) {
        console.log('已连接到设备:', peerId);
        
        // 检查所有连接状�?
        let healthyConnections = 0;
        this.connectedDevices.forEach((device, deviceId) => {
            const peerConnection = this.peerConnections.get(deviceId);
            const dataChannel = this.dataChannels.get(deviceId);
            
            if (peerConnection && 
                peerConnection.connectionState === 'connected' &&
                dataChannel && 
                dataChannel.readyState === 'open') {
                healthyConnections++;
            }
        });
        
        // 更新连接状�?
        if (healthyConnections > 0) {
            this.hideReconnectControls();
            this.updateConnectionStatus(`设备已连�?(${healthyConnections}�?，可以传输文件`);
        }
        
        // 更新设备状态显�?
        const deviceElements = document.querySelectorAll('.device-item');
        deviceElements.forEach(element => {
            const button = element.querySelector('.connect-btn');
            if (button && button.getAttribute('onclick').includes(peerId)) {
                element.classList.add('connected');
                button.textContent = '已连�?;
                button.disabled = true;
            }
        });
        
        // 显示文件传输区域
        this.showFileTransfer();
        
        // 如果是恢复的传输，尝试继续传�?
        if (this.isTransferring) {
            console.log('检测到之前有传输在进行，尝试恢复传�?);
            this.updateConnectionStatus('连接已恢复，正在检查传输状�?..');
            
            // 延迟恢复传输，等待所有连接稳�?
            setTimeout(() => {
                this.resumeFileTransfers();
            }, 1000);
        }
    }
    
    // 恢复文件传输
    resumeFileTransfers() {
        console.log('尝试恢复文件传输...');
        
        // 检查是否有未完成的接收文件
        if (this.receivingFiles.size > 0) {
            console.log('发现未完成的接收文件:', Array.from(this.receivingFiles.keys()));
            
            this.receivingFiles.forEach((fileInfo, fileId) => {
                if (!fileInfo.completed) {
                    console.log(`文件 ${fileInfo.fileName} 传输未完成，等待继续接收...`);
                    
                    // 显示进度�?
                    const progress = (fileInfo.receivedSize / fileInfo.totalSize) * 100;
                    this.showReceivedFile(fileInfo.fileName, progress);
                    
                    // 更新状�?
                    this.updateConnectionStatus(`正在恢复传输: ${fileInfo.fileName}`);
                }
            });
        }
        
        // 检查是否有未完成的发送队�?
        if (this.fileTransferQueue.length > 0) {
            console.log('发现未完成的发送队�?', this.fileTransferQueue.length, '个文�?);
            
            // 重新开始传输队�?
            setTimeout(() => {
                this.processFileQueue();
            }, 500);
        }
        
        // 如果没有任何传输，重置状�?
        if (this.receivingFiles.size === 0 && this.fileTransferQueue.length === 0) {
            console.log('没有发现需要恢复的传输，重置传输状�?);
            this.isTransferring = false;
            this.updateConnectionStatus('连接已恢复，可以传输文件');
        }
    }
    
    // 处理发送队列（断线恢复的兜底实现）
    processFileQueue() {
        if (!Array.isArray(this.fileTransferQueue) || this.fileTransferQueue.length === 0) {
            return;
        }
        const pending = this.fileTransferQueue.slice();
        this.fileTransferQueue.length = 0;
        pending.forEach(item => {
            try {
                const { file, peerId } = item || {};
                const dc = this.dataChannels.get(peerId);
                if (file && dc && dc.readyState === 'open') {
                    this.sendFileToDevice(file, peerId);
                }
            } catch (_) {}
        });
    }
    
    // 文件处理相关方法
    handleFileSelect(event) {
        const files = event.target.files;
        if (files.length > 0) {
            this.processFiles(files);
        }
    }
    
    // 拖拽功能已移除，专注于移动端体验
    
    async processFiles(files) {
        // temporary stub for debugging
        let open=false; this.dataChannels.forEach(dc=>{ if(dc && dc.readyState==="open") open=true; });
        if(!open){ this.showError("��δ�������ӣ��������ӵ��Զ��豸"); return; }
        let busy=false; this.dataChannels.forEach(dc=>{ if(dc && dc._isTransferring) busy=true; });
        if(busy){ this.showError("���ļ����ڴ��䣬���Ժ�����"); return; }
        Array.from(files).forEach((file, idx)=>{ this.dataChannels.forEach((dc, peerId)=>{ if(dc && dc.readyState==="open"){ setTimeout(()=> this.sendFileToDevice(file, peerId), idx*100); } }); });
    }
        
    
    generateFileId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
    
    async sendFileToDevice(file, peerId) {
        const dataChannel = this.dataChannels.get(peerId);
        
        if (!dataChannel || dataChannel.readyState !== 'open') {
            console.error('数据通道未准备就�?', peerId);
            return;
        }
        
        // 检查是否有正在进行的传�?
        if (dataChannel._isTransferring) {
            console.log('数据通道正在传输，稍后重�?..');
            setTimeout(() => this.sendFileToDevice(file, peerId), 1000);
            return;
        }
        
        // 标记传输开�?
        dataChannel._isTransferring = true;
        this.isTransferring = true;
        
        // 申请防睡眠锁
        this.requestWakeLock();
        
        // 更新页面标题
        document.title = `📤 ${file.name} - CrossSync`;
        
        // 显示后台传输提示（大文件�?
        if (file.size > 10 * 1024 * 1024) { // 10MB以上
            this.showBackgroundTransferTip();
        }
        
        // 为每个设备生成唯一文件ID（包含设备ID�?
        const fileId = `${peerId}_${this.generateFileId()}`;
        
        console.log('开始发送文件到设备:', file.name, file.size, 'ID:', fileId, 'to:', peerId);
        
        // 显示进度
        this.showFileProgress(file.name, 0);
        
        // 发送文件元信息
        const fileInfo = {
            type: 'file-info',
            fileId: fileId,
            name: file.name,
            size: file.size,
            mimeType: file.type || this.getMimeType(file.name),
            totalChunks: Math.ceil(file.size / 16384),
            fromDevice: this.deviceId,
            lastModified: file.lastModified || Date.now()
        };
        
        dataChannel.send(JSON.stringify(fileInfo));
        
        // 分块发送文�?
        const chunkSize = 16384; // 16KB chunks
        let offset = 0;
        let chunkIndex = 0;
        
        const sendChunk = () => {
            if (offset >= file.size) {
                // 发送文件结束标�?
                const endMessage = {
                    type: 'file-end',
                    fileId: fileId,
                    fromDevice: this.deviceId
                };
                dataChannel.send(JSON.stringify(endMessage));
                
                console.log('文件发送完�?', file.name, 'to:', peerId);
                this.showFileProgress(file.name, 100);
                
                // 清理传输状�?
                dataChannel._isTransferring = false;
                this.checkAllTransfersComplete();
                
                // 等待缓冲区清�?
                setTimeout(() => {
                    console.log('传输完成，清理缓冲区');
                }, 500);
                return;
            }
            
            const chunk = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();
            
            reader.onload = (e) => {
                // 先发送块头信�?
                const chunkHeader = {
                    type: 'file-chunk-header',
                    fileId: fileId,
                    chunkIndex: chunkIndex,
                    chunkSize: e.target.result.byteLength,
                    fromDevice: this.deviceId
                };
                dataChannel.send(JSON.stringify(chunkHeader));
                
                // 然后发送二进制数据
                dataChannel.send(e.target.result);
                
                offset += chunkSize;
                chunkIndex++;
                
                const progress = Math.min((offset / file.size) * 100, 100);
                this.showFileProgress(file.name, progress);
                
                // 检查缓冲区状态再继续
                if (dataChannel.bufferedAmount > 32768) { // 32KB
                    setTimeout(sendChunk, 50); // 等待缓冲区清�?
                } else {
                    setTimeout(sendChunk, 10); // 正常发送延�?
                }
            };
            
            reader.readAsArrayBuffer(chunk);
        };
        
        // 添加错误处理
        const errorHandler = (error) => {
            console.error('文件传输错误:', error);
            dataChannel._isTransferring = false;
            this.showError(`文件 ${file.name} 传输失败`);
        };
        
        try {
            sendChunk();
        } catch (error) {
            errorHandler(error);
        }
    }
    
    handleDataChannelMessage(event, peerId) {
        const data = event.data;
        
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);
                
                if (message.type === 'file-info') {
                    // 开始接收新文件
                    const fileInfo = {
                        fileId: message.fileId,
                        name: message.name,
                        size: message.size,
                        mimeType: message.mimeType,
                        totalChunks: message.totalChunks,
                        chunks: [],
                        receivedChunks: 0,
                        receivedBytes: 0,
                        fromPeerId: peerId,
                        nextExpectedChunk: 0
                    };
                    
                    this.receivingFiles.set(message.fileId, fileInfo);
                    console.log('开始接收文�?', message.name, 'ID:', message.fileId);
                    this.showReceivedFile(message.name, 0);
                    
                } else if (message.type === 'file-chunk-header') {
                    // 准备接收数据�?
                    const fileInfo = this.receivingFiles.get(message.fileId);
                    if (fileInfo) {
                        fileInfo.nextExpectedChunk = message.chunkIndex;
                        fileInfo.expectedChunkSize = message.chunkSize;
                        console.log(`准备接收 ${fileInfo.name} �?{message.chunkIndex}块，大小: ${message.chunkSize}`);
                    } else {
                        console.warn('未找到文件信�?', message.fileId);
                    }
                    
                } else if (message.type === 'file-end') {
                    // 文件传输完成
                    const fileInfo = this.receivingFiles.get(message.fileId);
                    if (fileInfo) {
                        console.log('文件接收完成:', fileInfo.name);
                        this.completeFileReceive(message.fileId);
                    }
                }
            } catch (error) {
                console.error('解析消息失败:', error);
            }
        } else {
            // 处理二进制数据块
            this.handleBinaryChunk(data, peerId);
        }
    }
    
    handleBinaryChunk(data, peerId) {
        // 查找等待此数据块的文�?
        for (const [fileId, fileInfo] of this.receivingFiles.entries()) {
            if (fileInfo.fromPeerId === peerId && 
                fileInfo.nextExpectedChunk !== undefined &&
                fileInfo.expectedChunkSize !== undefined &&
                data.byteLength === fileInfo.expectedChunkSize) {
                
                // 存储数据�?
                fileInfo.chunks[fileInfo.nextExpectedChunk] = new Uint8Array(data);
                fileInfo.receivedChunks++;
                fileInfo.receivedBytes += data.byteLength;
                
                const progress = (fileInfo.receivedChunks / fileInfo.totalChunks) * 100;
                this.showReceivedFile(fileInfo.name, progress);
                
                console.log(`文件 ${fileInfo.name} (${fileId}) 进度: ${fileInfo.receivedChunks}/${fileInfo.totalChunks} 块`);
                
                // 清除期望�?
                fileInfo.nextExpectedChunk = undefined;
                fileInfo.expectedChunkSize = undefined;
                return; // 找到匹配的文件后立即返回
            }
        }
        
        console.warn('未找到匹配的文件接收信息，数据块大小:', data.byteLength);
    }
    
    completeFileReceive(fileId) {
        const fileInfo = this.receivingFiles.get(fileId);
        if (!fileInfo) {
            console.error('未找到文件信�?', fileId);
            return;
        }
        
        console.log(`开始合并文�?${fileInfo.name}, �?{fileInfo.totalChunks}块`);
        
        // 检查缺失的数据�?
        const missingChunks = [];
        for (let i = 0; i < fileInfo.totalChunks; i++) {
            if (!fileInfo.chunks[i]) {
                missingChunks.push(i);
            }
        }
        
        if (missingChunks.length > 0) {
            console.error(`文件 ${fileInfo.name} 缺少 ${missingChunks.length} 个数据块:`, missingChunks);
            this.showError(`文件 ${fileInfo.name} 传输不完整，缺少 ${missingChunks.length} 个数据块`);
            return;
        }
        
        // 按顺序合并所有数据块
        const orderedChunks = [];
        let totalSize = 0;
        for (let i = 0; i < fileInfo.totalChunks; i++) {
            orderedChunks.push(fileInfo.chunks[i]);
            totalSize += fileInfo.chunks[i].byteLength;
        }
        
        const blob = new Blob(orderedChunks, {
            type: fileInfo.mimeType || this.getMimeType(fileInfo.name) || 'application/octet-stream'
        });
        
        console.log(`文件合并完成: ${fileInfo.name}, 期望大小: ${fileInfo.size}, 实际大小: ${blob.size}`);
        
        // 验证文件大小
        if (Math.abs(blob.size - fileInfo.size) > 100) { // 允许100字节的误�?
            console.warn(`文件大小不匹�? 期望 ${fileInfo.size}, 实际 ${blob.size}`);
        }
        
        // 创建下载链接
        const url = URL.createObjectURL(blob);
        const fileName = this.sanitizeFileName(fileInfo.name);
        
        // 检测当前设备和发送设备类�?
        const isWindowsReceiver = /windows/i.test(navigator.userAgent);
        const senderDevice = this.connectedDevices.get(fileInfo.fromPeerId);
        const isFromiPhone = senderDevice && (senderDevice.type === 'ios' || /iphone|ipad/i.test(senderDevice.name));
        
        // 如果是Windows接收iPhone文件，自动下�?
        if (isWindowsReceiver && isFromiPhone) {
            this.autoDownloadFile(url, fileName, 'iPhone');
        } else if (isWindowsReceiver) {
            // Windows接收其他设备文件，也可以自动下载
            this.autoDownloadFile(url, fileName, senderDevice ? senderDevice.name : '其他设备');
        }
        
        // 添加到接收文件列�?
        this.addReceivedFile(fileName, blob.size, url);
        
        console.log('文件接收完成:', fileName, '大小:', blob.size, 'FileID:', fileId);
        
        // 清理已完成的文件信息
        this.receivingFiles.delete(fileId);
    }
    
    autoDownloadFile(url, fileName, deviceName = '设备') {
        try {
            // 创建隐藏的下载链接并自动点击
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.style.display = 'none';
            a.target = '_blank'; // 在新窗口中打开，确保下�?
            document.body.appendChild(a);
            a.click();
            
            // 稍后移除元素
            setTimeout(() => {
                if (a.parentNode) {
                    a.parentNode.removeChild(a);
                }
            }, 1000);
            
            // 显示提示信息
            this.showAutoDownloadNotification(fileName, deviceName);
        } catch (error) {
            console.error('自动下载失败:', error);
            this.showError(`下载文件 ${fileName} 失败`);
        }
    }
    
    showAutoDownloadNotification(fileName, deviceName = '设备') {
        // 创建通知
        const notification = document.createElement('div');
        const isFromiPhone = deviceName === 'iPhone';
        const bgColor = isFromiPhone ? '#007bff' : '#28a745';
        const icon = isFromiPhone ? '📱' : '📥';
        
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${bgColor};
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
            max-width: 320px;
            font-size: 14px;
            line-height: 1.4;
        `;
        
        const moveScript = '';
        
        notification.innerHTML = `
            <strong>${icon} 来自${deviceName}的文件已下载</strong><br>
            ${fileName}<br>
            <small>已保存到下载文件�?/small>
            ${moveScript}
        `;
        
        document.body.appendChild(notification);
        
        // 6秒后自动消失（增加时间方便点击按钮）
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 6000);
    }
    
    showFileProgress(fileName, progress) {
        const progressArea = document.getElementById('progressArea');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const fileNameElement = document.getElementById('fileName');
        
        progressArea.style.display = 'block';
        fileNameElement.textContent = fileName;
        progressText.textContent = Math.round(progress) + '%';
        progressFill.style.width = progress + '%';
        
        if (progress >= 100) {
            setTimeout(() => {
                progressArea.style.display = 'none';
            }, 2000);
        }
    }
    
    showReceivedFile(fileName, progress) {
        // 显示接收进度
        console.log(`接收文件进度: ${fileName} - ${Math.round(progress)}%`);
        
        // 更新进度显示
        const progressArea = document.getElementById('progressArea');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const fileNameElement = document.getElementById('fileName');
        
        if (progress > 0) {
            progressArea.style.display = 'block';
            fileNameElement.textContent = `接收: ${fileName}`;
            progressText.textContent = Math.round(progress) + '%';
            progressFill.style.width = progress + '%';
            progressFill.style.backgroundColor = '#28a745'; // 接收时使用绿�?
        }
        
        if (progress >= 100) {
            setTimeout(() => {
                progressArea.style.display = 'none';
                progressFill.style.backgroundColor = '#007bff'; // 恢复默认颜色
            }, 2000);
        }
    }
    
    addReceivedFile(fileName, fileSize, downloadUrl) {
        const receivedFiles = document.getElementById('receivedFiles');
        const filesList = document.getElementById('filesList');
        
        receivedFiles.style.display = 'block';
        
        // 获取文件图标
        const fileIcon = this.getFileIcon(fileName);
        
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.innerHTML = `
            <div class="file-info">
                <div class="file-icon">${fileIcon}</div>
                <div class="file-details">
                    <h4>${fileName}</h4>
                    <div class="file-size">${this.formatFileSize(fileSize)}</div>
                </div>
            </div>
            <button class="download-btn" onclick="app.downloadFile('${downloadUrl}', '${fileName}')">
                下载
            </button>
        `;
        
        // 添加到列表顶部（最新接收的文件显示在上面）
        filesList.insertBefore(fileItem, filesList.firstChild);
    }
    
    downloadFile(url, fileName) {
        try {
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.target = '_blank';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            
            setTimeout(() => {
                if (a.parentNode) {
                    a.parentNode.removeChild(a);
                }
            }, 1000);
            
            console.log('手动下载文件:', fileName);
        } catch (error) {
            console.error('下载文件失败:', error);
            this.showError(`下载文件 ${fileName} 失败`);
        }
    }
    
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    getFileIcon(fileName) {
        const extension = fileName.split('.').pop().toLowerCase();
        
        const iconMap = {
            // 图片
            'jpg': '🖼�?, 'jpeg': '🖼�?, 'png': '🖼�?, 'gif': '🖼�?, 
            'bmp': '🖼�?, 'webp': '🖼�?, 'svg': '🖼�?, 'tiff': '🖼�?,
            // 文档
            'pdf': '📄', 'doc': '📄', 'docx': '📄', 'txt': '📄', 
            'rtf': '📄', 'odt': '📄',
            // 电子表格
            'xls': '📈', 'xlsx': '📈', 'csv': '📈', 'ods': '📈',
            // 演示文稿
            'ppt': '📉', 'pptx': '📉', 'odp': '📉',
            // 视频
            'mp4': '🎥', 'avi': '🎥', 'mov': '🎥', 'wmv': '🎥', 
            'flv': '🎥', 'mkv': '🎥', 'webm': '🎥',
            // 音频
            'mp3': '🎧', 'wav': '🎧', 'flac': '🎧', 'aac': '🎧', 
            'ogg': '🎧', 'wma': '🎧',
            // 压缩文件
            'zip': '🗄�?, 'rar': '🗄�?, '7z': '🗄�?, 'tar': '🗄�?, 
            'gz': '🗄�?, 'bz2': '🗄�?,
            // 代码文件
            'js': '📄', 'html': '📄', 'css': '📄', 'py': '📄', 
            'java': '📄', 'cpp': '📄', 'c': '📄', 'php': '📄',
            // 其他
            'exe': '⚙️', 'app': '⚙️', 'dmg': '💾', 'iso': '💾'
        };
        
        return iconMap[extension] || '📄';
    }
    
    getMimeType(fileName) {
        const extension = fileName.split('.').pop().toLowerCase();
        
        const mimeMap = {
            // 图片
            'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 
            'gif': 'image/gif', 'bmp': 'image/bmp', 'webp': 'image/webp', 
            'svg': 'image/svg+xml', 'tiff': 'image/tiff', 'ico': 'image/x-icon',
            // 文档
            'pdf': 'application/pdf', 'txt': 'text/plain', 'rtf': 'application/rtf',
            'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            // 电子表格
            'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'csv': 'text/csv',
            // 演示文稿
            'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            // 视频
            'mp4': 'video/mp4', 'avi': 'video/x-msvideo', 'mov': 'video/quicktime', 
            'wmv': 'video/x-ms-wmv', 'flv': 'video/x-flv', 'mkv': 'video/x-matroska', 
            'webm': 'video/webm',
            // 音频
            'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'flac': 'audio/flac', 
            'aac': 'audio/aac', 'ogg': 'audio/ogg', 'wma': 'audio/x-ms-wma',
            // 压缩文件
            'zip': 'application/zip', 'rar': 'application/x-rar-compressed', 
            '7z': 'application/x-7z-compressed', 'tar': 'application/x-tar', 
            'gz': 'application/gzip',
            // 代码文件
            'js': 'application/javascript', 'html': 'text/html', 'css': 'text/css', 
            'json': 'application/json', 'xml': 'application/xml',
            // 其他
            'exe': 'application/x-msdownload', 'dmg': 'application/x-apple-diskimage',
            'iso': 'application/x-iso9660-image'
        };
        
        return mimeMap[extension] || 'application/octet-stream';
    }
    
    sanitizeFileName(fileName) {
        // 清理文件名，移除非法字符
        const sanitized = fileName.replace(/[\\/:*?"<>|]/g, '_');
        // 确保文件名不为空且不太长
        if (sanitized.length === 0) return 'unknown_file';
        if (sanitized.length > 255) {
            const ext = sanitized.split('.').pop();
            const name = sanitized.substring(0, 250 - ext.length);
            return name + '.' + ext;
        }
        return sanitized;
    }
    
    showError(message) {
        // 优化的错误显�?
        console.error('错误:', message);
        
        // 创建错误通知
        const errorNotification = document.createElement('div');
        errorNotification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #dc3545;
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1001;
            max-width: 320px;
            font-size: 14px;
            line-height: 1.4;
        `;
        
        errorNotification.innerHTML = `
            <strong>⚠️ 错误</strong><br>
            ${message}
        `;
        
        document.body.appendChild(errorNotification);
        
        // 3秒后自动消失
        setTimeout(() => {
            if (errorNotification.parentNode) {
                errorNotification.parentNode.removeChild(errorNotification);
            }
        }, 3000);
    }
    
    showAbout() {
        alert('CrossSync v2.0.0\n跨平台文件同步传输工具\n支持iPhone、Android和Windows设备间的文件互传\n\n如果传输卡住，请刷新页面重新连接');
    }
    
    // 重置传输状态（调试用）
    resetTransferState() {
        console.log('重置所有传输状�?);
        this.dataChannels.forEach((dataChannel, peerId) => {
            if (dataChannel) {
                dataChannel._isTransferring = false;
                console.log(`重置 ${peerId} 的传输状态`);
            }
        });
        
        // 清理正在接收的文�?
        this.receivingFiles.clear();
        
        console.log('状态重置完成，可以重新传输文件');
    }
    
    // 初始化防睡眠机制
    async initWakeLock() {
        if ('wakeLock' in navigator) {
            console.log('支持Wake Lock API');
        } else {
            console.log('不支持Wake Lock API，将使用替代方案');
        }
    }
    
    // 申请防睡眠锁
    async requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                console.log('已启用防睡眠�?);
                
                this.wakeLock.addEventListener('release', () => {
                    console.log('防睡眠锁已释�?);
                });
            }
        } catch (err) {
            console.log('无法启用防睡眠锁:', err);
        }
    }
    
    // 释放防睡眠锁
    releaseWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release();
            this.wakeLock = null;
            console.log('已释放防睡眠�?);
        }
    }
    
    // 初始化页面可见性处�?
    initVisibilityHandler() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                console.log('页面切换到后�?);
                this.onPageHidden();
            } else {
                console.log('页面切换到前�?);
                this.onPageVisible();
            }
        });
        
        // 监听页面关闭事件
        window.addEventListener('beforeunload', () => {
            this.releaseWakeLock();
            if (this.isTransferring) {
                return '正在传输文件，确定要关闭吗？';
            }
        });
    }
    
    // 页面隐藏时的处理
    onPageHidden() {
        if (this.isTransferring) {
            // 显示后台传输提示
            this.showBackgroundTransferNotification();
        }
    }
    
    // 页面显示时的处理
    onPageVisible() {
        // 重新申请防睡眠锁
        if (this.isTransferring) {
            this.requestWakeLock();
            // 停止连接监控
            this.stopConnectionMonitoring();
        }
    }
    
    // 显示后台传输提示
    showBackgroundTransferNotification() {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('文件传输进行�?, {
                body: '请保持浏览器在后台运行，传输完成后会通知�?,
                icon: '/favicon.ico'
            });
        }
        
        // 更新页面标题
        document.title = '📤 传输�?.. - CrossSync';
    }
    
    // 检查所有传输是否完�?
    checkAllTransfersComplete() {
        let hasActiveTransfer = false;
        this.dataChannels.forEach((dataChannel) => {
            if (dataChannel._isTransferring) {
                hasActiveTransfer = true;
            }
        });
        
        if (!hasActiveTransfer) {
            this.isTransferring = false;
            this.releaseWakeLock();
            this.hideBackgroundTransferTip();
            this.stopConnectionMonitoring();
            document.title = 'CrossSync';
            
            // 发送完成通知
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('文件传输完成', {
                    body: '所有文件已传输完成',
                    icon: '/favicon.ico'
                });
            }
            
            console.log('所有传输完�?);
        }
    }
    
    // 请求通知权限
    async requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            console.log('通知权限:', permission);
            return permission === 'granted';
        }
        return Notification.permission === 'granted';
    }
    
    // 显示后台传输提示
    showBackgroundTransferTip() {
        const tipElement = document.getElementById('backgroundTip');
        if (tipElement) {
            tipElement.style.display = 'block';
            
            // 10秒后自动隐藏
            setTimeout(() => {
                if (tipElement) {
                    tipElement.style.display = 'none';
                }
            }, 10000);
        }
    }
    
    // 隐藏后台传输提示
    hideBackgroundTransferTip() {
        const tipElement = document.getElementById('backgroundTip');
        if (tipElement) {
            tipElement.style.display = 'none';
        }
    }
    
    // 开始连接监�?
    startConnectionMonitoring() {
        if (this.connectionMonitor) {
            clearInterval(this.connectionMonitor);
        }
        
        this.connectionMonitor = setInterval(() => {
            this.checkConnectionHealth();
        }, 2000); // �?秒检查一�?
        
        console.log('开始监控连接状�?);
    }
    
    // 停止连接监控
    stopConnectionMonitoring() {
        if (this.connectionMonitor) {
            clearInterval(this.connectionMonitor);
            this.connectionMonitor = null;
            console.log('停止监控连接状�?);
        }
    }
    
    // 检查连接健康状�?
    checkConnectionHealth() {
        let hasHealthyConnection = false;
        
        // 检查Socket连接
        if (this.socket && this.socket.connected) {
            hasHealthyConnection = true;
        }
        
        // 检查WebRTC连接
        this.peerConnections.forEach((pc, peerId) => {
            if (pc.connectionState === 'connected') {
                hasHealthyConnection = true;
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                console.warn(`WebRTC连接 ${peerId} 状态异�?`, pc.connectionState);
            }
        });
        
        // 检查数据通道
        this.dataChannels.forEach((dc, peerId) => {
            if (dc.readyState !== 'open') {
                console.warn(`数据通道 ${peerId} 状态异�?`, dc.readyState);
                hasHealthyConnection = false;
            }
        });
        
        if (!hasHealthyConnection && this.isTransferring) {
            console.error('检测到连接中断，停止传�?);
            this.handleConnectionLost();
        }
    }
    
    // 处理连接丢失
    handleConnectionLost() {
        // 保存传输状态以便恢�?
        this.saveTransferState();
        
        // 停止所有传�?
        this.dataChannels.forEach((dc) => {
            dc._isTransferring = false;
        });
        
        this.isTransferring = false;
        this.stopConnectionMonitoring();
        
        // 更新UI显示重连状�?
        document.title = '🔄 正在重连... - CrossSync';
        // 标记为需要恢复房�?
        this.hasAttemptedRoomFlow = false;
        this.shouldRejoinRoom = true;
        this.updateConnectionStatus('连接中断，正在尝试重�?..');
        
        // 不释放防睡眠锁，保持屏幕常亮以便重连
        // this.releaseWakeLock();
        
        // 显示重连提示而不是错�?
        this.showReconnectingNotification();
        
        console.log('检测到连接中断，开始重连流�?);
        
        // 显示重连按钮
        this.showReconnectControls();
        
        // 尝试自动重连
        this.attemptReconnect();
    }
    
    // 保存传输状�?
    saveTransferState() {
        if (this.isTransferring || this.roomId) {
            const state = {
                isTransferring: this.isTransferring,
                roomId: this.roomId,
                isHost: this.isHost,
                connectedDevices: Array.from(this.connectedDevices.entries()),
                receivingFiles: Array.from(this.receivingFiles.entries()),
                transferState: Array.from(this.transferState.entries()),
                timestamp: Date.now()
            };
            
            localStorage.setItem('fileTransferState', JSON.stringify(state));
            console.log('已保存传输状�?', state);
        }
    }
    
    // 恢复传输状�?
    restoreTransferState() {
        try {
            const savedState = localStorage.getItem('fileTransferState');
            if (savedState) {
                const state = JSON.parse(savedState);
                
                // 检查状态是否过期（5分钟�?
                if (Date.now() - state.timestamp < 5 * 60 * 1000) {
                    console.log('恢复之前的传输状�?', state);
                    
                    // 恢复传输标志
                    this.isTransferring = state.isTransferring;
                    this.isHost = state.isHost;
                    
                    // 恢复设备连接信息
                    if (state.connectedDevices) {
                        this.connectedDevices = new Map(state.connectedDevices);
                    }
                    
                    // 恢复接收文件信息
                    if (state.receivingFiles) {
                        this.receivingFiles = new Map(state.receivingFiles);
                    }
                    
                    // 恢复传输状�?
                    if (state.transferState) {
                        this.transferState = new Map(state.transferState);
                    }
                    
                    // 恢复房间信息
                    if (state.roomId) {
                        this.roomId = state.roomId;
                        // 重新加入/创建相同房间
                        setTimeout(() => {
                            if (this.isHost) {
                                console.log('尝试以相同ID重新创建房间:', this.roomId);
                                this.socket.emit('create-room', { roomId: state.roomId });
                            } else {
                                console.log('尝试重新加入房间:', this.roomId);
                                this.socket.emit('join-room', { roomId: state.roomId });
                            }
                        }, 1000);
                    }
                    
                    // 如果有传输在进行，显示提�?
                    if (this.isTransferring) {
                        this.updateConnectionStatus('正在恢复传输连接...');
                    }
                }
                
                // 清理已使用的状�?
                localStorage.removeItem('fileTransferState');
            }
        } catch (error) {
            console.error('恢复传输状态失�?', error);
        }
    }
    
    // 显示重连提示
    showReconnectingNotification() {
        const notification = document.createElement('div');
        notification.id = 'reconnectingNotification';
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #ffc107;
            color: #212529;
            padding: 15px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1001;
            max-width: 320px;
            font-size: 14px;
            animation: pulse 2s infinite;
        `;
        
        notification.innerHTML = `
            <strong>🔄 正在重连...</strong><br>
            连接中断，正在尝试重新连�?br>
            <small>请保持网络连接稳�?/small>
        `;
        
        // 移除旧的通知
        const oldNotification = document.getElementById('reconnectingNotification');
        if (oldNotification) {
            oldNotification.remove();
        }
        
        document.body.appendChild(notification);
    }
    
    // 显示重连控制按钮
    showReconnectControls() {
        console.log('显示重连按钮');
        const controlsElement = document.getElementById('connectionControls');
        console.log('connectionControls 元素:', controlsElement);
        
        if (controlsElement) {
            console.log('当前 display 样式:', controlsElement.style.display);
            
            // 强制移除display: none并设置为flex
            controlsElement.style.setProperty('display', 'flex', 'important');
            controlsElement.style.setProperty('visibility', 'visible', 'important');
            controlsElement.style.setProperty('opacity', '1', 'important');
            controlsElement.style.setProperty('position', 'relative', 'important');
            
            console.log('设置�?display 样式:', controlsElement.style.display);
            console.log('重连按钮已显�?);
            
            // 滚动到按钮位�?
            controlsElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            console.error('找不�?connectionControls 元素');
            // 尝试检�?DOM 结构
            console.log('当前页面 DOM:');
            console.log(document.body.innerHTML.slice(0, 1000));
        }
        this.updateConnectionStatus('连接中断', 'offline');
    }
    
    // 隐藏重连控制按钮
    hideReconnectControls() {
        const controlsElement = document.getElementById('connectionControls');
        if (controlsElement) {
            controlsElement.style.display = 'none';
        }
    }
    
    
    // 手动重连
    async manualReconnect() {
        const reconnectBtn = document.getElementById('reconnectBtn');
        if (reconnectBtn) {
            reconnectBtn.disabled = true;
            reconnectBtn.innerHTML = '🔄 正在连接...';
        }
        
        this.updateConnectionStatus('正在重新连接...', 'connecting');
        // 允许恢复房间流程
        this.hasAttemptedRoomFlow = false;
        this.shouldRejoinRoom = true;
        
        try {
            // 重置重连计数
            this.reconnectAttempts = 0;
            
            // 关闭现有连接
            if (this.socket) {
                this.socket.disconnect();
            }
            
            // 等待一下再重连
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // 重新连接
            this.socket.connect();
            
            // 等待连接成功
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('连接超时')), 10000);
                
                const onConnect = () => {
                    clearTimeout(timeout);
                    this.socket.off('connect_error', onError);
                    resolve();
                };
                
                const onError = (error) => {
                    clearTimeout(timeout);
                    this.socket.off('connect', onConnect);
                    reject(error);
                };
                
                this.socket.once('connect', onConnect);
                this.socket.once('connect_error', onError);
            });
            
            // 连接成功
            this.updateConnectionStatus('连接成功，等待设备加�?..');
            this.hideReconnectControls();
            
            if (reconnectBtn) {
                reconnectBtn.disabled = false;
                reconnectBtn.innerHTML = '🔄 重新连接';
            }
            
            console.log('手动重连成功');
            
        } catch (error) {
            console.error('手动重连失败:', error);
            this.updateConnectionStatus('重连失败，请检查网络连�?, true);
            
            if (reconnectBtn) {
                reconnectBtn.disabled = false;
                reconnectBtn.innerHTML = '🔄 重新连接';
            }
        }
    }
    
    // 重置连接（清理所有状态）
    resetConnection() {
        console.log('重置连接状�?);
        
        // 停止所有传�?
        this.isTransferring = false;
        this.dataChannels.forEach((dc) => {
            dc._isTransferring = false;
        });
        
        // 清理连接
        this.peerConnections.clear();
        this.dataChannels.clear();
        this.connectedDevices.clear();
        this.receivingFiles.clear();
        
        // 清理UI
        const progressArea = document.getElementById('progressArea');
        if (progressArea) {
            progressArea.style.display = 'none';
        }
        
        const devicesContainer = document.getElementById('devicesContainer');
        if (devicesContainer) {
            devicesContainer.innerHTML = '';
        }
        
        const devicesList = document.getElementById('devicesList');
        if (devicesList) {
            devicesList.style.display = 'none';
        }
        
        const fileTransfer = document.getElementById('fileTransfer');
        if (fileTransfer) {
            fileTransfer.style.display = 'none';
        }
        
        // 清理存储状�?
        localStorage.removeItem('fileTransferState');
        
        // 释放资源
        this.releaseWakeLock();
        this.hideBackgroundTransferTip();
        this.stopConnectionMonitoring();
        this.stopKeepAlive();
        this.shouldRejoinRoom = false;
        this.hasAttemptedRoomFlow = false;
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('room');
            window.history.replaceState(null, '', url.toString());
        } catch (e) {}
        
        // 重置标题
        document.title = 'CrossSync';
        
        // 重新初始�?
        this.reconnectAttempts = 0;
        this.roomId = null;
        this.isHost = false;
        
        // 重新检查URL参数或创建房�?
        setTimeout(() => {
            this.checkUrlParams();
            this.startKeepAlive();
        }, 1000);
        
        this.updateConnectionStatus('已重置，正在重新初始�?..');
        this.updateConnectionStatus('已重置，正在重新初始�?..', 'connecting');
        this.hideReconnectControls();
    }
    
    // 尝试重新连接
    async attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('达到最大重连次数，停止重连');
            this.updateConnectionStatus('自动重连失败，请手动重连', 'offline');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000); // 指数退避，最�?0�?
        
        console.log(`�?{this.reconnectAttempts}次重连尝试，${delay}ms后重�?..`);
        
        setTimeout(async () => {
            try {
                // 重新连接Socket
                if (!this.socket.connected) {
                    this.socket.connect();
                }
                
                // 等待连接成功
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
                    this.socket.once('connect', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                });
                
                console.log('重连成功，正在恢复传�?..');
                this.reconnectAttempts = 0;
                
                // 隐藏重连按钮
                this.hideReconnectControls();
                
                // 显示重连成功提示
                this.showReconnectSuccess();
                
            } catch (error) {
                console.log('重连失败:', error.message);
                this.attemptReconnect(); // 继续尝试
            }
        }, delay);
    }
    
    // 显示重连成功提示
    showReconnectSuccess() {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #28a745;
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1002;
            max-width: 320px;
            font-size: 14px;
            animation: slideInRight 0.3s ease-out;
        `;
        
        notification.innerHTML = `
            <strong>�?连接已恢�?/strong><br>
            可以重新开始文件传�?
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 3000);
    }
    
    // 初始化PWA支持
    initPWA() {
        if ('serviceWorker' in navigator) {
            // 注册 Service Worker 以支持后台运�?
            navigator.serviceWorker.register('/sw.js').then((registration) => {
                console.log('Service Worker 注册成功');
            }).catch((error) => {
                console.log('Service Worker 注册失败:', error);
            });
        }
    }
    
    // 启动保活机制
    startKeepAlive() {
        // �?0秒发送一次心�?
        this.keepAliveInterval = setInterval(() => {
            if (this.socket && this.socket.connected) {
                this.socket.emit('ping');
            }
        }, 30000);
        
        console.log('已启动心跳保活机�?);
    }
    
    // 停止保活机制
    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            console.log('已停止心跳保活机�?);
        }
    }
    
    // 文件传输事件处理
    handleFileTransferStart(data) {
        console.log('文件传输开�?', data);
    }
    
    handleFileTransferProgress(data) {
        console.log('文件传输进度:', data);
    }
    
    handleFileTransferComplete(data) {
        console.log('文件传输完成:', data);
    }
}

// 初始化应�?
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new FileTransferApp();
});

// 防止页面刷新时丢失连�?
window.addEventListener('beforeunload', () => {
    if (app && app.socket) {
        app.socket.disconnect();
    }
});

