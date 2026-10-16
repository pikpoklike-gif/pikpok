const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const cors = require('cors');

admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }
});

const getBotToken = () => process.env.TELEGRAM_BOT_TOKEN || (functions.config().telegram && functions.config().telegram.token);
const getChatId = () => process.env.TELEGRAM_CHAT_ID || (functions.config().telegram && functions.config().telegram.chat_id);

async function verifyFirebaseToken(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!token) return res.status(401).json({ error: 'No auth token provided' });
        req.user = await admin.auth().verifyIdToken(token);
        next();
    } catch (e) {
        console.error('Token verification failed:', e.message);
        res.status(401).json({ error: 'Invalid auth token' });
    }
}

app.post('/api/telegram/upload-video', verifyFirebaseToken, upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No video file provided' });
        const botToken = getBotToken();
        const chatId = getChatId();
        if (!botToken || !chatId) return res.status(500).json({ error: 'Telegram bot is not configured' });

        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('video', req.file.buffer, {
            filename: req.file.originalname || 'video.mp4',
            contentType: req.file.mimetype || 'video/mp4'
        });
        form.append('caption', (req.body.caption || '').slice(0, 1024));
        form.append('supports_streaming', 'true');

        const response = await axios.post(
            `https://api.telegram.org/bot${botToken}/sendVideo`,
            form,
            { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180000 }
        );

        if (!response.data.ok) throw new Error(response.data.description || 'Telegram rejected the video');

        const result = response.data.result;
        const video = result.video;
        const thumb = video.thumbnail;
        const protocol = req.protocol;
        const host = req.get('host');

        res.json({
            ok: true,
            fileId: video.file_id,
            fileUniqueId: video.file_unique_id,
            messageId: result.message_id,
            chatId: result.chat.id,
            thumbFileId: thumb ? thumb.file_id : null,
            duration: video.duration,
            width: video.width,
            height: video.height,
            fileSize: video.file_size,
            proxyUrl: `${protocol}://${host}/api/telegram/file/${video.file_id}`,
            thumbProxyUrl: thumb ? `${protocol}://${host}/api/telegram/thumb/${thumb.file_id}` : null
        });
    } catch (err) {
        console.error('Telegram upload error:', err.response?.data || err.message);
        const detail = err.response?.data?.description || err.message;
        res.status(500).json({ error: detail });
    }
});

app.post('/api/telegram/upload-photo', verifyFirebaseToken, upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No photo file provided' });
        const botToken = getBotToken();
        const chatId = getChatId();
        if (!botToken || !chatId) return res.status(500).json({ error: 'Telegram bot is not configured' });

        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('photo', req.file.buffer, {
            filename: req.file.originalname || 'photo.jpg',
            contentType: req.file.mimetype || 'image/jpeg'
        });
        form.append('caption', `Profile photo for ${req.user.uid}`);

        const response = await axios.post(
            `https://api.telegram.org/bot${botToken}/sendPhoto`,
            form,
            { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
        );

        if (!response.data.ok) throw new Error(response.data.description || 'Telegram rejected the photo');

        const photos = response.data.result.photo;
        const largest = photos[photos.length - 1];
        const protocol = req.protocol;
        const host = req.get('host');

        res.json({
            ok: true,
            fileId: largest.file_id,
            messageId: response.data.result.message_id,
            url: `${protocol}://${host}/api/telegram/thumb/${largest.file_id}`
        });
    } catch (err) {
        console.error('Telegram photo upload error:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data?.description || err.message });
    }
});

app.get('/api/telegram/file/:fileId', async (req, res) => {
    try {
        const botToken = getBotToken();
        if (!botToken) return res.status(500).json({ error: 'Bot not configured' });

        const fileRes = await axios.get(
            `https://api.telegram.org/bot${botToken}/getFile`,
            { params: { file_id: req.params.fileId } }
        );
        if (!fileRes.data.ok) throw new Error('File not found in Telegram');

        const filePath = fileRes.data.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

        if (req.headers.range) {
            const rangeRes = await axios.get(fileUrl, {
                responseType: 'stream',
                headers: { Range: req.headers.range }
            });
            res.status(rangeRes.status);
            if (rangeRes.headers['content-range']) res.setHeader('Content-Range', rangeRes.headers['content-range']);
            if (rangeRes.headers['accept-ranges']) res.setHeader('Accept-Ranges', rangeRes.headers['accept-ranges']);
            if (rangeRes.headers['content-length']) res.setHeader('Content-Length', rangeRes.headers['content-length']);
            res.setHeader('Content-Type', 'video/mp4');
            rangeRes.data.pipe(res);
            return;
        }

        const stream = await axios.get(fileUrl, { responseType: 'stream', timeout: 30000 });
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Accept-Ranges', 'bytes');
        stream.data.pipe(res);
    } catch (err) {
        console.error('File proxy error:', err.message);
        res.status(404).json({ error: 'File not available' });
    }
});

app.get('/api/telegram/thumb/:fileId', async (req, res) => {
    try {
        const botToken = getBotToken();
        if (!botToken) return res.status(500).end();

        const fileRes = await axios.get(
            `https://api.telegram.org/bot${botToken}/getFile`,
            { params: { file_id: req.params.fileId } }
        );
        if (!fileRes.data.ok) throw new Error('Thumbnail not found');

        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileRes.data.result.file_path}`;
        const stream = await axios.get(fileUrl, { responseType: 'stream' });

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        stream.data.pipe(res);
    } catch (err) {
        res.status(404).end();
    }
});

exports.api = functions
    .runWith({ memory: '1GB', timeoutSeconds: 300 })
    .https.onRequest(app);
