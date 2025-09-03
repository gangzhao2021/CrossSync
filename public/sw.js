// Service Worker for File Transfer Tool
// 帮助应用在后台保持活跃

const CACHE_NAME = 'file-transfer-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/styles.css',
    '/background-transfer-styles.css',
    '/app.js',
    '/manifest.json'
];

// 安装Service Worker
self.addEventListener('install', (event) => {
    console.log('Service Worker installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Caching app shell');
                return cache.addAll(urlsToCache);
            })
    );
});

// 激活Service Worker
self.addEventListener('activate', (event) => {
    console.log('Service Worker activating...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// 拦截网络请求
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // 如果缓存中有该资源，返回缓存的版本
                if (response) {
                    return response;
                }
                
                // 否则从网络获取
                return fetch(event.request);
            })
    );
});

// 处理后台同步（如果浏览器支持）
self.addEventListener('sync', (event) => {
    console.log('Background sync event:', event.tag);
    
    if (event.tag === 'file-transfer-keepalive') {
        event.waitUntil(
            // 发送keep-alive请求
            fetch('/api/keepalive', { method: 'POST' })
                .then(() => {
                    console.log('Keep-alive sent successfully');
                })
                .catch((error) => {
                    console.log('Keep-alive failed:', error);
                })
        );
    }
});

// 处理推送消息
self.addEventListener('push', (event) => {
    console.log('Push message received:', event.data?.text());
    
    const options = {
        body: event.data?.text() || 'File transfer update',
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        tag: 'file-transfer',
        requireInteraction: true
    };
    
    event.waitUntil(
        self.registration.showNotification('File Transfer Tool', options)
    );
});

// 处理通知点击
self.addEventListener('notificationclick', (event) => {
    console.log('Notification clicked');
    event.notification.close();
    
    // 打开或聚焦到应用窗口
    event.waitUntil(
        clients.matchAll({ type: 'window' })
            .then((clientList) => {
                for (const client of clientList) {
                    if (client.url === '/' && 'focus' in client) {
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow('/');
                }
            })
    );
});

// 保持Service Worker活跃的心跳机制
let heartbeatInterval;

function startHeartbeat() {
    heartbeatInterval = setInterval(() => {
        console.log('Service Worker heartbeat');
        // 向所有客户端发送心跳消息
        self.clients.matchAll().then((clients) => {
            clients.forEach((client) => {
                client.postMessage({
                    type: 'SW_HEARTBEAT',
                    timestamp: Date.now()
                });
            });
        });
    }, 30000); // 每30秒一次心跳
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// 监听来自主线程的消息
self.addEventListener('message', (event) => {
    console.log('SW received message:', event.data);
    
    if (event.data && event.data.type === 'START_HEARTBEAT') {
        startHeartbeat();
    } else if (event.data && event.data.type === 'STOP_HEARTBEAT') {
        stopHeartbeat();
    }
});

console.log('Service Worker loaded');