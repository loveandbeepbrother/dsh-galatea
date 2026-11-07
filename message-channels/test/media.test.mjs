/**
 * 渠道图片收发：媒体工具、指纹兼容、QQ 与微信的入站下载和出站上传（development_fake）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    aesEcbPaddedSize, decryptAesEcb, detectImageType, encryptAesEcb, plainFileLinks, readOutboundFile, readOutboundImage,
    splitReplySegments, weixinImageKey,
} from '../media.js';
import { incomingFingerprintOf, userInputOf } from '../replies.js';
import { createQQPlatform, quoteOfRaw } from '../platforms/qq.js';
import { createWeixinPlatform, quoteOfItems } from '../platforms/weixin.js';
import { createHash } from 'node:crypto';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

test('图片类型按文件头识别', () => {
    assert.equal(detectImageType(PNG), 'image/png');
    assert.equal(detectImageType(JPEG), 'image/jpeg');
    assert.equal(detectImageType(new Uint8Array(16)), null);
});

test('发图规则：只有本机绝对路径的 Markdown 图片拆成图片段，纯文字回复原样一段', () => {
    assert.deepEqual(splitReplySegments('只是文字\n第二行'), [{ kind: 'text', text: '只是文字\n第二行' }]);
    assert.deepEqual(splitReplySegments('看图：![猫](D:\\pics\\cat.png) 好看吧'), [
        { kind: 'text', text: '看图：' },
        { kind: 'image', path: 'D:\\pics\\cat.png', alt: '猫' },
        { kind: 'text', text: ' 好看吧' },
    ]);
    assert.deepEqual(splitReplySegments('![](C:/a/b.jpg)'), [{ kind: 'image', path: 'C:/a/b.jpg', alt: '' }]);
    const web = '网页图 ![x](https://example.com/a.png) 和相对路径 ![y](a.png)';
    assert.deepEqual(splitReplySegments(web), [{ kind: 'text', text: web }]);
});

test('文件链接在手机上只留文件名；网络链接与图片引用不动', () => {
    assert.equal(
        plainFileLinks('新大纲见 [示例书_大纲_v16.md](<D:\\writing\\示例书\\大纲 v16.md>)，分析在 [分析](docs/a.md#L3) 和 [旧稿](file:///D:/x.md)'),
        '新大纲见 示例书_大纲_v16.md，分析在 分析 和 旧稿',
    );
    const kept = '参考 [官网](https://example.com/a) 与 ![图](D:\\a.png)';
    assert.equal(plainFileLinks(kept), kept);
});

test('本机文件链接留文字，网络链接原样', () => {
    assert.equal(plainFileLinks('[说明](D:\\x\\a.md) 与 [网站](https://a.com)'), '说明 与 [网站](https://a.com)');
});

test('出站图片：存在、受支持类型才可读；否则给出错误码', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-media-'));
    const good = join(dir, 'a.png');
    const bad = join(dir, 'a.txt');
    await writeFile(good, PNG);
    await writeFile(bad, 'not an image');
    const image = await readOutboundImage(good);
    assert.equal(image.mediaType, 'image/png');
    await assert.rejects(readOutboundImage(bad), { code: 'IMAGE_TYPE_UNSUPPORTED' });
    await assert.rejects(readOutboundImage(join(dir, 'missing.png')), { code: 'IMAGE_NOT_FOUND' });
    await assert.rejects(readOutboundImage('relative.png'), { code: 'IMAGE_PATH_INVALID' });
});

test('出站文件：本机绝对路径的非空文件原样读出，带文件名；否则给出错误码', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channel-file-'))
    const good = join(dir, '报告.md')
    const empty = join(dir, 'empty.md')
    await writeFile(good, '# 报告')
    await writeFile(empty, '')
    const file = await readOutboundFile(good)
    assert.equal(file.name, '报告.md')
    assert.equal(file.bytes.toString('utf8'), '# 报告')
    await assert.rejects(readOutboundFile(empty), { code: 'FILE_EMPTY' })
    await assert.rejects(readOutboundFile(join(dir, 'missing.md')), { code: 'FILE_NOT_FOUND' })
    await assert.rejects(readOutboundFile('relative.md'), { code: 'FILE_PATH_INVALID' })
})

test('微信 AES 密钥：hex 的 aeskey 优先；aes_key 可为 16 字节或 32 位 hex 的 base64', () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    assert.deepEqual(weixinImageKey({ aeskey: key.toString('hex') }), key);
    assert.deepEqual(weixinImageKey({ media: { aes_key: key.toString('base64') } }), key);
    assert.deepEqual(weixinImageKey({ media: { aes_key: Buffer.from(key.toString('hex')).toString('base64') } }), key);
    assert.equal(weixinImageKey({ media: {} }), null);
    const cipher = encryptAesEcb(Buffer.from(PNG), key);
    assert.equal(cipher.length, aesEcbPaddedSize(PNG.length));
    assert.deepEqual(new Uint8Array(decryptAesEcb(cipher, key)), PNG);
});

test('指纹：没有图片时与旧算法完全相同；有图片时计入张数', () => {
    const base = { platform: 'qq', accountId: 'A', conversationId: 'C', senderId: 'S', platformMessageId: 'M', text: '你好' };
    const legacy = createHash('sha256').update(JSON.stringify([
        'galatea-channels/fingerprint/1', 'qq', 'A', 'C', 'S', 'M', '你好',
    ]), 'utf8').digest('hex');
    assert.equal(incomingFingerprintOf(base), legacy);
    assert.equal(incomingFingerprintOf({ ...base, imageCount: 0 }), legacy);
    assert.notEqual(incomingFingerprintOf({ ...base, imageCount: 1 }), legacy);
});

test('原生 user 输入：至多一个文字块加图片块；其他形状不可核对', () => {
    const image = { type: 'image', attachment: { attachmentId: 'sha256:x' } };
    assert.deepEqual(userInputOf({ content: [{ type: 'text', text: 'a' }] }), { text: 'a', imageCount: 0 });
    assert.deepEqual(userInputOf({ content: [{ type: 'text', text: 'a' }, image, image] }), { text: 'a', imageCount: 2 });
    assert.deepEqual(userInputOf({ content: [image] }), { text: '', imageCount: 1 });
    assert.equal(userInputOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), null);
    assert.equal(userInputOf({ content: [{ type: 'file' }] }), null);
});

// ------------------------------- QQ -------------------------------

function qqFake() {
    const state = { bots: [], sends: [], uploads: [] };
    class FakeQQBot {
        constructor(options) {
            this.options = options;
            this.handlers = new Map();
            state.bots.push(this);
        }
        on(event, handler) { this.handlers.set(event, handler); return this; }
        emit(event, ...args) { return this.handlers.get(event)?.(...args); }
        start(signal) { return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); }
        stop() {}
        async uploadMedia(options) { state.uploads.push(options); return { file_uuid: 'U', file_info: 'FILE-INFO', ttl: 60 }; }
        async send(options) { state.sends.push(options); return { id: 'SRV-IMG-1' }; }
    }
    return { state, sdk: { QQBot: FakeQQBot, MsgType: { TEXT: 0 } }, connector: { startQrConnect() { return () => {}; } } };
}

const QQ_OWNER = { appId: 'APP-1', appSecret: 'SECRET-1', userOpenid: 'OWN-1' };

function qqImageMessage(id, content, attachments) {
    return {
        rawEventType: 'C2C_MESSAGE_CREATE',
        kind: 'c2c',
        senderId: 'OWN-1',
        senderIsBot: false,
        content,
        messageId: id,
        msgType: 0,
        attachments,
        replyTarget: { scope: 'c2c', targetId: 'OWN-1', msgId: id },
        raw: { id, author: { user_openid: 'OWN-1', bot: false } },
    };
}

test('引用的解析（真实推送的形状）：QQ 官方的 ref_msg_idx 和 msg_elements，微信的 ref_msg；没引用时是 null', () => {
    const qq = {
        content: '引用', message_type: 103,
        message_scene: { ext: ['ref_msg_idx=REFIDX_A', 'msg_idx=REFIDX_B'], source: 'default' },
        msg_elements: [{ attachments: [{ content_type: 'file', filename: 'picture.png' }], content: '', message_type: 103, msg_idx: 'REFIDX_A' }],
    };
    assert.deepEqual(quoteOfRaw(qq), { refIdx: 'REFIDX_A', image: 'picture.png' });
    assert.deepEqual(quoteOfRaw({ message_scene: { ext: ['ref_msg_idx=REFIDX_A'] }, msg_elements: [{ content: '被引用的字', msg_idx: 'REFIDX_A' }] }), { refIdx: 'REFIDX_A', text: '被引用的字' });
    assert.deepEqual(quoteOfRaw({ message_scene: { ext: ['ref_msg_idx=REFIDX_A'] } }), { refIdx: 'REFIDX_A' }, '没有元素也知道是引用');
    assert.equal(quoteOfRaw({ message_scene: { ext: ['msg_idx=REFIDX_B'], source: 'default' } }), null);
    assert.equal(quoteOfRaw({ content: '普通消息' }), null);

    const weixin = [{ type: 1, ref_msg: { message_item: { type: 0, msg_id: '1000000000000000001' } }, text_item: { text: '引用' } }];
    assert.deepEqual(quoteOfItems(weixin), { platformMessageId: '1000000000000000001' });
    assert.deepEqual(quoteOfItems([{ type: 1, ref_msg: { title: '标题', message_item: { msg_id: 'm', image_item: {} } } }]), { platformMessageId: 'm', text: '标题', image: true });
    assert.equal(quoteOfItems([{ type: 1, text_item: { text: '普通消息' } }]), null);
    assert.equal(quoteOfItems(undefined), null);
});

test('QQ 入站图片：下载附件放进 images；只有图片时正文为空串；下载失败写进正文', async () => {
    const { state, sdk, connector } = qqFake();
    const fetched = [];
    const fetchImpl = async (url) => {
        fetched.push(url);
        if (url.includes('broken')) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(0) };
    };
    const platform = await createQQPlatform({ sdk, connector, fetchImpl });
    const received = [];
    const controller = new AbortController();
    const listening = platform.listen({ credential: QQ_OWNER, onMessage: async (envelope) => { received.push(envelope); }, signal: controller.signal });
    await flush();
    const bot = state.bots[0];
    await bot.emit('message', {}, qqImageMessage('M1', ' ', [{ content_type: 'image/png', url: 'multimedia.nt.qq.com.cn/a' }]));
    await bot.emit('message', {}, qqImageMessage('M2', '看这个', [
        { content_type: 'image/jpeg', url: 'https://multimedia.nt.qq.com.cn/b' },
        { content_type: 'image/jpeg', url: 'https://multimedia.nt.qq.com.cn/broken' },
    ]));
    await bot.emit('message', {}, qqImageMessage('M3', '', [{ content_type: 'audio/silk', url: 'https://x/voice' }]));
    controller.abort();
    await listening;

    assert.deepEqual(fetched, ['https://multimedia.nt.qq.com.cn/a', 'https://multimedia.nt.qq.com.cn/b', 'https://multimedia.nt.qq.com.cn/broken']);
    assert.equal(received.length, 2, '非图片附件且无正文的消息仍跳过');
    assert.equal(received[0].text, '');
    assert.deepEqual(received[0].images, [{ mediaType: 'image/png', data: Buffer.from(PNG).toString('base64') }]);
    assert.equal(received[1].text, '看这个\n[1 张图片接收失败]');
    assert.equal(received[1].images.length, 1);
});

test('QQ 出站图片：先 uploadMedia（IMAGE=1），再以 msg_type 7 被动回复', async () => {
    const { state, sdk, connector } = qqFake();
    const platform = await createQQPlatform({ sdk, connector });
    const controller = new AbortController();
    const listening = platform.listen({ credential: QQ_OWNER, onMessage: () => undefined, signal: controller.signal });
    await flush();
    const result = await platform.send({
        credential: QQ_OWNER,
        peerId: 'OWN-1',
        anchor: { scope: 'c2c', targetId: 'OWN-1', msgId: 'M1' },
        text: 'D:\\pics\\cat.png',
        image: { path: 'D:\\pics\\cat.png', bytes: Buffer.from(PNG), mediaType: 'image/png' },
        deliveryId: 'd-1',
    });
    controller.abort();
    await listening;
    assert.deepEqual(result, { kind: 'platform-accepted', platformMessageId: 'SRV-IMG-1', clientId: null });
    assert.equal(state.uploads[0].fileType, 1);
    assert.equal(state.uploads[0].fileData, Buffer.from(PNG).toString('base64'));
    assert.deepEqual(state.uploads[0].target, { scope: 'c2c', targetId: 'OWN-1', msgId: 'M1' });
    assert.equal(state.sends[0].msgType, 7);
    assert.deepEqual(state.sends[0].media, { file_info: 'FILE-INFO' });
});

test('QQ 出站文件：uploadMedia（FILE=4，buffer 与文件名），再以 msg_type 7 被动回复', async () => {
    const { state, sdk, connector } = qqFake();
    const platform = await createQQPlatform({ sdk, connector });
    const controller = new AbortController();
    const listening = platform.listen({ credential: QQ_OWNER, onMessage: () => undefined, signal: controller.signal });
    await flush();
    const result = await platform.send({
        credential: QQ_OWNER,
        peerId: 'OWN-1',
        anchor: { scope: 'c2c', targetId: 'OWN-1', msgId: 'M1' },
        text: 'D:\\docs\\大纲.md',
        file: { path: 'D:\\docs\\大纲.md', bytes: Buffer.from('# 大纲'), name: '大纲.md' },
        deliveryId: 'd-file',
    });
    controller.abort();
    await listening;
    assert.equal(result.kind, 'platform-accepted');
    assert.equal(state.uploads[0].fileType, 4);
    assert.equal(state.uploads[0].fileName, '大纲.md');
    assert.equal(state.uploads[0].buffer.toString('utf8'), '# 大纲');
    assert.equal(state.sends[0].msgType, 7);
});

// ------------------------------- 微信 -------------------------------

const WEIXIN_OWNER = { botToken: 'TOKEN-1', botId: 'BOT-1', userId: 'USER-1', baseUrl: 'https://ilinkai.weixin.qq.com/' };

function response({ status = 200, body = '', bytes, headers = {} }) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        arrayBuffer: async () => {
            if (bytes === undefined) return new ArrayBuffer(0);
            const buffer = Buffer.from(bytes);
            return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
        },
    };
}

test('微信入站图片：CDN 下载并按 aeskey 解密，只有图片也发出', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const encrypted = encryptAesEcb(Buffer.from(JPEG), key);
    const batch = JSON.stringify({
        ret: 0,
        get_updates_buf: 'C1',
        msgs: [{
            message_id: 7, message_type: 1, message_state: 2, from_user_id: 'USER-1', context_token: 'CTX',
            item_list: [{ type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'Q=1&x' } } }],
        }],
    });
    const calls = [];
    let polls = 0;
    const fetchImpl = async (url, init = {}) => {
        calls.push(String(url));
        if (String(url).includes('getupdates')) {
            polls += 1;
            if (polls === 1) return response({ body: batch });
            return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
        }
        return response({ bytes: encrypted });
    };
    const platform = await createWeixinPlatform({ fetchImpl });
    const received = [];
    const controller = new AbortController();
    const listening = platform.listen({ credential: WEIXIN_OWNER, onMessage: async (envelope) => { received.push(envelope); }, signal: controller.signal });
    for (let i = 0; i < 200 && received.length === 0; i += 1) await flush();
    controller.abort();
    await listening;
    assert.equal(calls[1], 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=Q%3D1%26x');
    assert.equal(received.length, 1);
    assert.equal(received[0].text, '');
    assert.deepEqual(received[0].images, [{ mediaType: 'image/jpeg', data: Buffer.from(JPEG).toString('base64') }]);
});

test('微信出站图片：getuploadurl → 加密上传 CDN → sendmessage 图片项（aes_key 为 hex 串的 base64）', async () => {
    const calls = [];
    let uploadedKeyHex = null;
    let uploadedCipher = null;
    const fetchImpl = async (url, init = {}) => {
        const call = { url: String(url), body: init.body };
        calls.push(call);
        if (call.url.includes('getuploadurl')) {
            uploadedKeyHex = JSON.parse(init.body).aeskey;
            return response({ body: { ret: 0, upload_param: 'UP' } });
        }
        if (call.url.includes('/upload?')) {
            uploadedCipher = Buffer.from(init.body);
            return response({ headers: { 'x-encrypted-param': 'DOWNLOAD-PARAM' } });
        }
        return response({ body: { ret: 0 } });
    };
    const platform = await createWeixinPlatform({ fetchImpl });
    const result = await platform.send({
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1', contextToken: 'CTX' },
        text: 'D:\\cat.png',
        image: { path: 'D:\\cat.png', bytes: Buffer.from(PNG), mediaType: 'image/png' },
        deliveryId: 'delivery-img',
    });
    assert.deepEqual(result, { kind: 'platform-accepted', platformMessageId: null, clientId: 'delivery-img' });
    const getUpload = JSON.parse(calls[0].body);
    assert.equal(getUpload.media_type, 1);
    assert.equal(getUpload.rawsize, PNG.length);
    assert.equal(getUpload.filesize, aesEcbPaddedSize(PNG.length));
    assert.equal(getUpload.rawfilemd5, createHash('md5').update(PNG).digest('hex'));
    assert.match(calls[1].url, /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?encrypted_query_param=UP&filekey=[0-9a-f]{32}$/);
    assert.deepEqual(new Uint8Array(decryptAesEcb(uploadedCipher, Buffer.from(uploadedKeyHex, 'hex'))), PNG);
    const sent = JSON.parse(calls[2].body);
    assert.equal(sent.msg.client_id, 'delivery-img');
    assert.deepEqual(sent.msg.item_list, [{
        type: 2,
        image_item: {
            media: { encrypt_query_param: 'DOWNLOAD-PARAM', aes_key: Buffer.from(uploadedKeyHex, 'ascii').toString('base64'), encrypt_type: 1 },
            mid_size: aesEcbPaddedSize(PNG.length),
        },
    }]);
});

test('微信出站图片：上传失败时什么都没发出（notSent）', async () => {
    const fetchImpl = async (url) => (String(url).includes('getuploadurl')
        ? response({ body: { ret: 0, upload_param: 'UP' } })
        : response({ status: 500 }));
    const platform = await createWeixinPlatform({ fetchImpl });
    const error = await platform.send({
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1', contextToken: 'CTX' },
        text: 'x',
        image: { path: 'D:\\cat.png', bytes: Buffer.from(PNG), mediaType: 'image/png' },
        deliveryId: 'd',
    }).then(() => null, (failure) => failure);
    assert.equal(error.notSent, true);
    assert.equal(error.code, 'MEDIA_UPLOAD_FAILED');
});

test('微信出站文件：getuploadurl（FILE=3）→ 加密上传 CDN → sendmessage 文件项（文件名与明文长度）', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), body: init.body });
        if (String(url).includes('getuploadurl')) return response({ body: { ret: 0, upload_param: 'UP' } });
        if (String(url).includes('/upload?')) return response({ headers: { 'x-encrypted-param': 'DOWNLOAD-PARAM' } });
        return response({ body: { ret: 0 } });
    };
    const platform = await createWeixinPlatform({ fetchImpl });
    const bytes = Buffer.from('# 报告\n正文');
    const result = await platform.send({
        credential: WEIXIN_OWNER,
        peerId: 'USER-1',
        anchor: { toUserId: 'USER-1', contextToken: 'CTX' },
        text: 'D:\\报告.md',
        file: { path: 'D:\\报告.md', bytes, name: '报告.md' },
        deliveryId: 'delivery-file',
    });
    assert.equal(result.kind, 'platform-accepted');
    assert.equal(JSON.parse(calls[0].body).media_type, 3);
    const [item] = JSON.parse(calls[2].body).msg.item_list;
    assert.equal(item.type, 4);
    assert.equal(item.file_item.file_name, '报告.md');
    assert.equal(item.file_item.len, String(bytes.length));
    assert.equal(item.file_item.media.encrypt_query_param, 'DOWNLOAD-PARAM');
});
