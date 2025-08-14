const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3010;

// 中间件设置
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// 存储连接的设备和房间信息
const devices = new Map(); // socketId -> device info
const rooms = new Map();   // roomId -> Set of socketIds

// 设备类型检测
function detectDeviceType(userAgent) {
    const ua = userAgent.toLowerCase();
    
    if (/iphone|ipad|ipod/.test(ua)) {
        return { type: 'ios', icon: '📱', name: 'iPhone/iPad' };
    } else if (/android/.test(ua)) {
        return { type: 'android', icon: '📱', name: 'Android设备' };
    } else if (/windows/.test(ua)) {
        return { type: 'windows', icon: '💻', name: 'Windows电脑' };
    } else if (/macintosh|mac os x/.test(ua)) {
        return { type: 'mac', icon: '💻', name: 'Mac电脑' };
    } else if (/linux/.test(ua)) {
        return { type: 'linux', icon: '💻', name: 'Linux电脑' };
    } else {
        return { type: 'unknown', icon: '📱', name: '未知设备' };
    }
}

// 生成房间ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 获取本机局域网IP地址
function getLocalIPAddress() {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    
    // 常见的局域网IP段优先级
    const preferredRanges = [
        '192.168.2.',    // 当前可用的网段
        '192.168.1.',    // 最常见的家庭网络
        '192.168.0.',    // 另一个常见的家庭网络
        '10.0.',         // 企业网络
        '172.16.'        // 企业网络
    ];
    
    let foundIPs = [];
    
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                foundIPs.push(net.address);
            }
        }
    }
    
    // 按优先级返回IP
    for (const range of preferredRanges) {
        for (const ip of foundIPs) {
            if (ip.startsWith(range)) {
                return ip;
            }
        }
    }
    
    // 如果没有找到优先IP，返回第一个外部IPv4地址
    return foundIPs.length > 0 ? foundIPs[0] : 'localhost';
}

// 获取所有可用的局域网IP地址
function getAllLocalIPs() {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const ips = [];
    
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal && net.address.startsWith('192.168')) {
                ips.push(net.address);
            }
        }
    }
    
    return ips;
}

// API路由
app.get('/api/qr/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;
        const protocol = req.secure ? 'https' : 'http';
        
        // 使用优先的局域网IP地址
        const primaryIP = getLocalIPAddress();
        const port = req.app.get('port') || PORT;
        const url = `${protocol}://${primaryIP}:${port}?room=${roomId}`;
        
        const qrCodeDataUrl = await QRCode.toDataURL(url, {
            width: 200,
            margin: 2,
            color: {
                dark: '#007bff',
                light: '#ffffff'
            }
        });
        
        // 返回主要QR码和所有备用IP地址
        const allIPs = getAllLocalIPs();
        res.json({ 
            qrCode: qrCodeDataUrl, 
            url,
            primaryIP,
            alternativeIPs: allIPs.filter(ip => ip !== primaryIP)
        });
    } catch (error) {
        console.error('QR码生成错误:', error);
        res.status(500).json({ error: '无法生成QR码' });
    }
});

// Socket.IO连接处理
io.on('connection', (socket) => {
    console.log(`新设备连接: ${socket.id}`);
    
    // 设备注册
    socket.on('register-device', (data) => {
        const userAgent = socket.handshake.headers['user-agent'] || '';
        const deviceInfo = detectDeviceType(userAgent);
        
        const device = {
            id: socket.id,
            name: data.name || deviceInfo.name,
            type: deviceInfo.type,
            icon: deviceInfo.icon,
            ip: socket.handshake.address,
            userAgent,
            roomId: null,
            connectedAt: new Date()
        };
        
        devices.set(socket.id, device);
        
        socket.emit('device-registered', {
            deviceId: socket.id,
            deviceInfo: device
        });
        
        console.log(`设备已注册: ${device.name} (${socket.id})`);
    });
    
    // 创建房间
    socket.on('create-room', () => {
        const device = devices.get(socket.id);
        if (!device) return;
        
        const roomId = generateRoomId();
        device.roomId = roomId;
        
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
        }
        rooms.get(roomId).add(socket.id);
        
        socket.join(roomId);
        
        socket.emit('room-created', { roomId });
        console.log(`房间已创建: ${roomId} by ${device.name}`);
        
        // 广播房间内设备列表
        broadcastRoomDevices(roomId);
    });
    
    // 加入房间
    socket.on('join-room', (data) => {
        const { roomId } = data;
        const device = devices.get(socket.id);
        if (!device) return;
        
        // 检查房间是否存在
        if (!rooms.has(roomId)) {
            socket.emit('error', { message: '房间不存在' });
            return;
        }
        
        // 检查房间是否已满（限制4个设备）
        if (rooms.get(roomId).size >= 4) {
            socket.emit('error', { message: '房间已满' });
            return;
        }
        
        device.roomId = roomId;
        rooms.get(roomId).add(socket.id);
        socket.join(roomId);
        
        socket.emit('room-joined', { roomId });
        console.log(`设备加入房间: ${device.name} -> ${roomId}`);
        
        // 广播房间内设备列表
        broadcastRoomDevices(roomId);
    });
    
    // WebRTC信令处理
    socket.on('webrtc-offer', (data) => {
        const { targetId, offer } = data;
        socket.to(targetId).emit('webrtc-offer', {
            sourceId: socket.id,
            offer
        });
    });
    
    socket.on('webrtc-answer', (data) => {
        const { targetId, answer } = data;
        socket.to(targetId).emit('webrtc-answer', {
            sourceId: socket.id,
            answer
        });
    });
    
    socket.on('webrtc-ice-candidate', (data) => {
        const { targetId, candidate } = data;
        socket.to(targetId).emit('webrtc-ice-candidate', {
            sourceId: socket.id,
            candidate
        });
    });
    
    // CrossSync 文件传输状态更新
    socket.on('file-transfer-start', (data) => {
        const { targetId, fileName, fileSize } = data;
        socket.to(targetId).emit('file-transfer-start', {
            sourceId: socket.id,
            fileName,
            fileSize
        });
    });
    
    socket.on('file-transfer-progress', (data) => {
        const { targetId, progress } = data;
        socket.to(targetId).emit('file-transfer-progress', {
            sourceId: socket.id,
            progress
        });
    });
    
    socket.on('file-transfer-complete', (data) => {
        const { targetId, fileName } = data;
        socket.to(targetId).emit('file-transfer-complete', {
            sourceId: socket.id,
            fileName
        });
    });
    
    socket.on('file-transfer-error', (data) => {
        const { targetId, error } = data;
        socket.to(targetId).emit('file-transfer-error', {
            sourceId: socket.id,
            error
        });
    });
    
    // 设备断开连接
    socket.on('disconnect', () => {
        console.log(`设备断开连接: ${socket.id}`);
        
        const device = devices.get(socket.id);
        if (device && device.roomId) {
            const roomId = device.roomId;
            const roomDevices = rooms.get(roomId);
            
            if (roomDevices) {
                roomDevices.delete(socket.id);
                
                // 如果房间为空，删除房间
                if (roomDevices.size === 0) {
                    rooms.delete(roomId);
                    console.log(`房间已删除: ${roomId}`);
                } else {
                    // 广播更新的设备列表
                    broadcastRoomDevices(roomId);
                }
            }
        }
        
        devices.delete(socket.id);
    });
    
    // 心跳处理
    socket.on('ping', () => {
        socket.emit('pong');
    });
    
    // 错误处理
    socket.on('error', (error) => {
        console.error(`Socket错误 (${socket.id}):`, error);
    });
});

// 广播房间内设备列表
function broadcastRoomDevices(roomId) {
    const roomDevices = rooms.get(roomId);
    if (!roomDevices) return;
    
    const deviceList = Array.from(roomDevices).map(socketId => {
        const device = devices.get(socketId);
        return device ? {
            id: device.id,
            name: device.name,
            type: device.type,
            icon: device.icon
        } : null;
    }).filter(Boolean);
    
    io.to(roomId).emit('room-devices-updated', { devices: deviceList });
}

// 清理过期房间和设备（每30分钟执行一次）
setInterval(() => {
    const now = new Date();
    const expireTime = 30 * 60 * 1000; // 30分钟
    
    for (const [socketId, device] of devices.entries()) {
        if (now - device.connectedAt > expireTime) {
            console.log(`清理过期设备: ${device.name} (${socketId})`);
            
            if (device.roomId) {
                const roomDevices = rooms.get(device.roomId);
                if (roomDevices) {
                    roomDevices.delete(socketId);
                    if (roomDevices.size === 0) {
                        rooms.delete(device.roomId);
                    }
                }
            }
            
            devices.delete(socketId);
        }
    }
}, 30 * 60 * 1000);

// Keep-alive API
app.post('/api/keepalive', (req, res) => {
    res.json({ status: 'alive', timestamp: Date.now() });
});

// 服务器状态API
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        devices: devices.size,
        rooms: rooms.size,
        uptime: process.uptime()
    });
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
    const primaryIP = getLocalIPAddress();
    const allIPs = getAllLocalIPs();
    
    console.log(`\n🚀 CrossSync 服务器运行在端口 ${PORT}`);
    console.log(`📍 本地访问: http://localhost:${PORT}`);
    console.log(`\n📱 手机可尝试以下地址:`);
    
    allIPs.forEach((ip, index) => {
        const marker = ip === primaryIP ? '⭐' : '  ';
        console.log(`${marker} http://${ip}:${PORT}`);
    });
    
    console.log(`\n💡 提示:`);
    console.log(`   • 确保手机和电脑连接到同一WiFi网络`);
    console.log(`   • 如果无法访问，请运行 setup-firewall.bat 配置防火墙`);
    console.log(`   • ⭐ 标记的是推荐地址\n`);
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('收到SIGTERM信号，正在关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

module.exports = app;