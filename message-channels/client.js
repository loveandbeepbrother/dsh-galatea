/**
 * The bundle's page on the Plugins detail screen: connect QQ, connect WeChat.
 *
 * MIT NOTICE
 * ----------
 * Adapted from `dsh-channel-wechat`'s `lib/client.js`
 * (`reference/platforms/wechat-client.js` in this repository),
 * Copyright (c) the dsh-channel-wechat authors, licensed under the MIT License.
 * A copy of that licence ships in `licenses/` beside this file and the required
 * attribution is repeated in `THIRD_PARTY_NOTICES.md`.
 *
 * What is reused is the lazy-CJS loader shape, the `plugins.bundle.config` slot
 * registration, React and the `Button`/`Input` primitives, and the connection
 * card (status line, QR, verify code, sign-out). What is dropped is everything
 * that made that page about a *new* agent: the cwd field, the model picker, the
 * permission selector and the version/update card. A channel here connects to
 * the main assistant session that already exists, so there is nothing of the
 * sort to configure, and no new chat UI, model, project or permission choice is
 * offered.
 *
 * The page is hand-written lazy CJS rather than a bundled TSX entry: the loader
 * wrapper is the whole artifact, and nothing here needs CSS modules, dynamic
 * chunks or JSX.
 *
 * Two rules this file keeps because breaking either is invisible until it
 * matters:
 *
 *  - every request path is **document-relative**. The shell serves the app
 *    below its own base, a leading `/` escapes it, and the client build gate
 *    rejects a rooted application path outright.
 *  - the QR code is an `<img>` loaded from the Host, never markup and never a
 *    `dangerouslySetInnerHTML` block: the SVG is a document this page renders as
 *    an image, and nothing in it can run.
 */

/**
 * The package name. The loader registers this bundle under it, and it is also the
 * slot key below and the patch row's package name: one constant, so a rename can
 * not update one place and leave the other.
 */
var PACKAGE_NAME = '@loveandbeepbrother/dsh-galatea-channels';

window.__ModuleLoader__.load({
    id: PACKAGE_NAME,
    factory(require) {
        var React = require('react');
        var h = React.createElement;
        var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        var Button = primitives.Button;
        var Input = primitives.Input;

        /**
         * The id the loader registers this bundle under (`PACKAGE_NAME`).
         *
         * It is also the slot key below and the patch row's package name: a key
         * that does not match leaves the page registered and never rendered,
         * with no error anywhere.
         */
        var PLUGIN_ID = PACKAGE_NAME;

        /** The slot a bundle's own detail page reserves for itself. */
        var SLOT = 'plugins.bundle.config';

        /**
         * The paths this page calls, all document-relative.
         *
         * These mirror `routes.js`; both halves are named here so a change on one
         * side is a visible edit rather than a silent 404.
         */
        var ROUTES = {
            status: 'api/galatea-channels/status',
            qr: 'api/galatea-channels/qr.svg',
            begin: 'api/galatea-channels/begin',
            verifyCode: 'api/galatea-channels/verify-code',
            selectAccount: 'api/galatea-channels/select-account',
            cancel: 'api/galatea-channels/cancel',
            disconnect: 'api/galatea-channels/disconnect',
            groupUnbind: 'api/galatea-channels/group-unbind',
        };

        /** Polling cadence while the page is visible, and while it is hidden. */
        var POLL_MS = 1500;
        var POLL_HIDDEN_MS = 8000;

        /** Copy for the page, in the two languages the shell selects between. */
        var DICT = {
            zh: {
                note: '连接 DSH 里的中枢会话：共享人格、心智和记忆。',
                qq: 'QQ',
                weixin: '微信',
                groups: '已接的群：',
                group: '{group} → {session}',
                groupGone: '{group} → {session}（这个会话已不在）',
                unbindGroup: '解绑',
                notConnected: '尚未连接{platform}',
                connectedAs: '已连接{platform}：{account}',
                connectedPlain: '已连接{platform}',
                connect: '连接{platform}',
                reconnect: '重新连接',
                cancel: '取消',
                disconnect: '断开连接',
                waiting: '正在获取二维码…',
                scanned: '已扫描，请在手机上确认',
                needVerify: '请输入手机上显示的验证码',
                submit: '提交',
                chooseAccount: '请选择要连接的账号',
                unknownPending: '发送结果待核对，可在 DSH 查看原回复。',
                qrAlt: '连接{platform}的二维码',
                errorUnknown: '连接未完成，请重试。',
                errorCoded: '连接未完成（{code}），请重试。',
                'error:INGRESS_UNAVAILABLE': '这个渠道接不进中枢（INGRESS_UNAVAILABLE），请查看 DSH 的日志。',
                'error:PAIR_SAVE_TIMEOUT': '保存连接超时，请重新连接。',
                'error:VERIFY_FAILED': '验证码错了三次，请重新连接。',
                'error:PAIR_TIMEOUT': '10 分钟内没有收到你的消息，请重新连接。',
                'error:AUTH_FAILED': '登录凭据被拒绝了，请检查这个渠道的设置后重新连接。',
                'error:CONNECT_FAILED': '连不上这个渠道，请确认它已经启动。',
                'error:ACCOUNT_MISMATCH': '那边登录的不是已绑定的账号。',
                'error:stale-attempt': '这次扫码已失效，请重新连接。',
                'error:qr-unavailable': '暂时拿不到二维码，请稍后重试。',
                'error:attempt-timeout': '等待超时，请重新连接。',
                'error:pair-not-started': '连接没有启动，请重试。',
                'error:no-hub': '还没有中枢会话：先在 DSH 里打开一个会话，输入 /hub 定成中枢，再来连接。',
                'error:NO_HUB': '还没有中枢会话：先在 DSH 里打开一个会话，输入 /hub 定成中枢，再来连接。',
                'error:verify-failed': '验证码未被接受，请重试。',
                'error:unavailable': '渠道暂时不可用，请稍后重试。',
                'error:OWNER_UNVERIFIED': '核对不了中枢会话的主人，已停止收发。',
                'error:MAIN_SESSION_UNAVAILABLE': '找不到中枢会话，暂时无法连接。',
                'error:CHANNEL_OWNER_UNAVAILABLE': '另一个 DSH 实例正在使用该渠道，请关闭它后重试。',
            },
            en: {
                note: 'Connects to the hub session in DSH: same persona, mind and memory.',
                qq: 'QQ',
                weixin: 'WeChat',
                groups: 'Attached groups:',
                group: '{group} → {session}',
                groupGone: '{group} → {session} (this session is gone)',
                unbindGroup: 'Unbind',
                notConnected: '{platform} is not connected',
                connectedAs: 'Connected to {platform} as {account}',
                connectedPlain: '{platform} is connected',
                connect: 'Connect {platform}',
                reconnect: 'Connect again',
                cancel: 'Cancel',
                disconnect: 'Disconnect',
                waiting: 'Fetching the QR code…',
                scanned: 'Scanned; confirm on your phone',
                needVerify: 'Enter the code shown on your phone',
                submit: 'Submit',
                chooseAccount: 'Choose the account to connect',
                unknownPending: 'A send result is unconfirmed; check the original reply in DSH.',
                qrAlt: 'QR code for connecting {platform}',
                errorUnknown: 'The connection did not complete. Try again.',
                errorCoded: 'The connection did not complete ({code}). Try again.',
                'error:INGRESS_UNAVAILABLE': 'This channel cannot reach the hub session (INGRESS_UNAVAILABLE). Check the DSH log.',
                'error:PAIR_SAVE_TIMEOUT': 'Saving the connection timed out. Connect again.',
                'error:VERIFY_FAILED': 'The code was wrong three times. Connect again.',
                'error:PAIR_TIMEOUT': 'No message from you arrived within 10 minutes. Connect again.',
                'error:AUTH_FAILED': 'The credentials were rejected. Check this channel\'s settings and connect again.',
                'error:CONNECT_FAILED': 'This channel is not reachable. Make sure it is running.',
                'error:ACCOUNT_MISMATCH': 'The other side is signed in to a different account than the bound one.',
                'error:stale-attempt': 'That scan is no longer valid. Connect again.',
                'error:qr-unavailable': 'No QR code is available right now. Try again shortly.',
                'error:attempt-timeout': 'The wait timed out. Connect again.',
                'error:pair-not-started': 'The connection did not start. Try again.',
                'error:no-hub': 'There is no hub session yet. Open a session in DSH, type /hub to make it the hub, then connect.',
                'error:NO_HUB': 'There is no hub session yet. Open a session in DSH, type /hub to make it the hub, then connect.',
                'error:verify-failed': 'The code was not accepted. Try again.',
                'error:unavailable': 'The channel is unavailable right now. Try again shortly.',
                'error:OWNER_UNVERIFIED': 'This DSH cannot verify the owner of the hub session, so channel traffic stopped.',
                'error:MAIN_SESSION_UNAVAILABLE': 'The hub session is unavailable right now.',
                'error:CHANNEL_OWNER_UNAVAILABLE': 'Another DSH instance is already using these channels. Close it and try again.',
            },
        };

        /**
         * Build the page's translator.
         *
         * The wrapper's `inject` is `['slots']`, so this page has no locale
         * service to ask; the document's own language is the only signal
         * available, and Chinese is the fallback when it says nothing.
         *
         * @returns a `t(key, vars)` function.
         */
        function createTranslator() {
            var language = 'zh';
            if (typeof document !== 'undefined' && document.documentElement !== null
                && typeof document.documentElement.lang === 'string'
                && document.documentElement.lang !== ''
                && document.documentElement.lang.toLowerCase().indexOf('zh') !== 0) {
                language = 'en';
            }
            var strings = DICT[language];
            function translate(key, vars) {
                var template = strings[key];
                if (typeof template !== 'string') template = DICT.zh[key];
                if (typeof template !== 'string') return key;
                if (vars === undefined) return template;
                return template.replace(/\{(\w+)\}/g, function (match, name) {
                    return typeof vars[name] === 'string' ? vars[name] : match;
                });
            }
            // 登记的平台自带名字和提示（`{ zh, en }`）：按同一个语言取。
            translate.language = language;
            return translate;
        }

        /** 登记时给的文字：字符串照用；`{ zh, en }` 按页面语言取，没有就取中文。 */
        function localized(t, value, fallback) {
            if (typeof value === 'string' && value !== '') return value;
            if (value !== null && typeof value === 'object') {
                var picked = value[t.language];
                if (typeof picked === 'string' && picked !== '') return picked;
                if (typeof value.zh === 'string' && value.zh !== '') return value.zh;
            }
            return fallback;
        }

        /**
         * Fold a reported phase onto one spelling.
         *
         * The runtime contract writes the verify phase two ways
         * (`need-verify`, `need_verifycode`); both mean the same state, and no
         * third spelling is guessed at.
         *
         * @param value - the reported phase.
         * @returns the normalised phase, or an empty string when absent.
         */
        function normalizePhase(value) {
            if (typeof value !== 'string') return '';
            var phase = value.trim().toLowerCase().replace(/_/g, '-');
            if (phase === 'need-verifycode' || phase === 'need-verify-code') return 'need-verify';
            return phase;
        }

        /**
         * Map a stable code onto a sentence.
         *
         * Only the dictionary ever reaches the screen: an unknown code renders
         * the generic sentence, never the code, and no Host message is displayed
         * at all.
         *
         * @param t - the page translator.
         * @param code - the stable code from a status projection or a response.
         * @returns the sentence to render.
         */
        function errorText(t, code) {
            if (typeof code !== 'string' || code === '') return t('errorUnknown');
            var key = 'error:' + code;
            var text = t(key);
            // 没有专门说明的码也照实显示，用户转述时能直接对上原因。
            return text === key ? t('errorCoded', { code: code }) : text;
        }

        /**
         * One failed request, carrying its stable code and no message.
         *
         * @param code - the code the Host answered with.
         * @returns an Error whose `code` is the only detail the page reads.
         */
        function channelError(code) {
            var error = new Error('galatea-channels request failed');
            error.code = typeof code === 'string' && code !== '' ? code : 'unavailable';
            return error;
        }

        /** One platform's entry out of the status projection, or null. */
        function channelOf(projection, platform) {
            if (projection === null || typeof projection !== 'object') return null;
            var channels = projection.channels;
            if (!Array.isArray(channels)) return null;
            for (var index = 0; index < channels.length; index += 1) {
                var entry = channels[index];
                if (entry !== null && typeof entry === 'object' && entry.platform === platform) return entry;
            }
            return null;
        }

        /** The account label a connected channel reports, if any. */
        function accountLabel(channel) {
            if (channel === null || typeof channel !== 'object') return '';
            if (typeof channel.accountId === 'string' && channel.accountId !== '') return channel.accountId;
            if (typeof channel.senderId === 'string' && channel.senderId !== '') return channel.senderId;
            return '';
        }

        /**
         * One platform's connection card.
         *
         * Every card is the same component so the channels cannot drift into
         * different journeys; only the label, the platform id and the pairing
         * hints a registered platform brings differ.
         */
        function ChannelCard(props) {
            var t = props.t;
            var platform = props.platform;
            var label = props.label;
            var channel = props.channel;
            var busy = props.busy;

            var codeState = React.useState('');
            var code = codeState[0];
            var setCode = codeState[1];

            var phase = normalizePhase(channel === null ? '' : channel.phase);
            // Only the Host's own `connected` fact counts. A phase that says a
            // scan succeeded is not a connection, and this page must never
            // present it as one.
            var connected = channel !== null && channel.connected === true;
            var attemptId = channel !== null && typeof channel.pairAttemptId === 'string' && channel.pairAttemptId !== ''
                ? channel.pairAttemptId
                : null;
            var pairing = attemptId !== null && !connected;
            // 进行中的尝试就是二维码需要的全部条件：路由会再核对 attemptId 和
            // 当前 QR 文本，所以 phase 名称不参与判断。
            var attemptLive = pairing && phase !== 'error' && phase !== 'closed';
            var showQr = attemptLive;
            // 数值版本由 Host 投影而来；同一张码版本不变，换码必然变化。
            var qrRevision = channel !== null && typeof channel.qrRevision === 'number' && Number.isFinite(channel.qrRevision)
                ? channel.qrRevision
                : 0;
            var choices = channel !== null && Array.isArray(channel.choices) ? channel.choices : [];
            var unknownCount = channel !== null && typeof channel.unknownCount === 'number' ? channel.unknownCount : 0;
            var errorCode = channel !== null && typeof channel.errorCode === 'string' ? channel.errorCode : '';
            var account = accountLabel(channel);

            // 登记的平台可以带自己的配对提示（例如不扫码、先发一句话再填验证码的）；没带就用通用的。
            var hints = channel !== null && channel.hints !== null && typeof channel.hints === 'object'
                ? (channel.hints[t.language] || channel.hints.zh || null)
                : null;
            var hint = function (key) {
                return hints !== null && typeof hints[key] === 'string' && hints[key] !== '' ? hints[key] : t(key);
            };
            var groups = channel !== null && Array.isArray(channel.groups)
                ? channel.groups.filter(function (group) {
                    return group !== null && typeof group === 'object' && typeof group.name === 'string' && group.name !== '';
                }).map(function (group) {
                    return {
                        groupId: typeof group.groupId === 'string' ? group.groupId : '',
                        name: group.name,
                        session: typeof group.session === 'string' ? group.session : '',
                        gone: typeof group.gone === 'string' && group.gone !== '',
                    };
                })
                : [];
            var verifyText = hint('needVerify');
            var phaseText = null;
            if (!connected) {
                if (phase === 'scanned') phaseText = t('scanned');
                else if (phase === 'need-verify') phaseText = verifyText;
                else if (phase === 'choose-account') phaseText = t('chooseAccount');
                else if (attemptLive) phaseText = hint('waiting');
            }

            return h('section', { className: 'cw-card' },
                h('div', { className: 'cw-card-head' }, h('h3', { className: 'cw-card-title' }, label)),
                h('div', { className: 'cw-card-body' },
                    h('p', { className: connected ? 'cw-ok' : 'cw-muted' },
                        connected
                            ? (account === ''
                                ? t('connectedPlain', { platform: label })
                                : t('connectedAs', { platform: label, account: account }))
                            : t('notConnected', { platform: label })),

                    // 支持群的平台已接的群：群名 → 会话，每个可以解绑（解绑可以一句话恢复，不另加确认）。
                    groups.length > 0
                        ? h('div', { className: 'cw-groups' },
                            h('p', { className: 'cw-muted' }, t('groups')),
                            h('ul', { className: 'cw-group-list' }, groups.map(function (group, index) {
                                var text = group.session === ''
                                    ? group.name
                                    : t(group.gone ? 'groupGone' : 'group', { group: group.name, session: group.session });
                                return h('li', { key: group.groupId === '' ? String(index) : group.groupId, className: 'cw-group-item' },
                                    h('span', null, text),
                                    group.groupId === '' || typeof props.onUnbindGroup !== 'function' ? null : h(Button, {
                                        variant: 'outline',
                                        size: 'sm',
                                        disabled: busy,
                                        onClick: function () { props.onUnbindGroup(group.groupId); },
                                    }, t('unbindGroup')));
                            })))
                        : null,

                    // The status line and the code form one left-aligned group,
                    // so a state change moves nothing sideways.
                    showQr || phaseText !== null
                        ? h('div', { className: 'cw-qr-wrap' },
                            phaseText === null ? null : h('p', { className: 'cw-muted' }, phaseText),
                            // Attempt 与版本共同决定图片 URL：同码 URL 稳定，换码 URL 必变。
                            showQr && qrRevision > 0
                                ? h('img', {
                                    className: 'cw-qr',
                                    alt: t('qrAlt', { platform: label }),
                                    src: ROUTES.qr
                                        + '?platform=' + encodeURIComponent(platform)
                                        + '&attemptId=' + encodeURIComponent(attemptId)
                                        + '&revision=' + encodeURIComponent(qrRevision),
                                })
                                : null)
                        : null,

                    // The code field exists only while the Host is asking for one.
                    phase === 'need-verify' && pairing
                        ? h('form', {
                            className: 'cw-row',
                            onSubmit: function (event) {
                                event.preventDefault();
                                var value = code.trim();
                                if (value === '' || busy) return;
                                props.onVerify(platform, attemptId, value);
                                setCode('');
                            },
                        },
                            h(Input, {
                                value: code,
                                inputMode: 'numeric',
                                autoComplete: 'one-time-code',
                                placeholder: verifyText,
                                'aria-label': verifyText,
                                disabled: busy,
                                onChange: function (event) { setCode(event.target.value); },
                            }),
                            h(Button, { variant: 'primary', size: 'sm', type: 'submit', disabled: busy }, t('submit')))
                        : null,

                    // The choice list exists only while the Host offers choices,
                    // and each button names the exact account it sends back.
                    phase === 'choose-account' && pairing && choices.length > 0
                        ? h('div', { className: 'cw-row' }, choices.map(function (choice, index) {
                            var accountId = choice !== null && typeof choice === 'object'
                                && typeof choice.accountId === 'string'
                                ? choice.accountId
                                : '';
                            if (accountId === '') return null;
                            var senderId = choice !== null && typeof choice === 'object'
                                && typeof choice.senderId === 'string'
                                ? choice.senderId
                                : '';
                            return h(Button, {
                                key: accountId + ':' + String(index),
                                variant: 'outline',
                                size: 'sm',
                                disabled: busy,
                                onClick: function () { props.onSelect(platform, attemptId, accountId); },
                            }, senderId === '' ? accountId : senderId);
                        }))
                        : null,

                    h('div', { className: 'cw-row' },
                        // A pairing starts only from this press: nothing on this
                        // page begins a scan on its own.
                        !connected && !pairing
                            ? h(Button, {
                                variant: 'primary',
                                size: 'sm',
                                disabled: busy,
                                onClick: function () { props.onBegin(platform); },
                            }, account === '' ? t('connect', { platform: label }) : t('reconnect'))
                            : null,
                        pairing
                            ? h(Button, {
                                variant: 'outline',
                                size: 'sm',
                                disabled: busy,
                                onClick: function () { props.onCancel(platform, attemptId); },
                            }, t('cancel'))
                            : null,
                        connected
                            ? h(Button, {
                                variant: 'outline',
                                size: 'sm',
                                disabled: busy,
                                onClick: function () { props.onDisconnect(platform); },
                            }, t('disconnect'))
                            : null),

                    // An unconfirmed send is reported, never retried blind: a
                    // resend button here could post the same reply twice.
                    unknownCount > 0 ? h('p', { className: 'cw-hint' }, t('unknownPending')) : null,

                    errorCode === '' ? null : h('p', { className: 'cw-err' }, errorText(t, errorCode))));
        }

        /**
         * The page: one note, then a card per platform.
         *
         * A single poll watches the one status projection both cards read, so
         * opening the page costs one request per tick rather than one per card
         * and nothing outside this page is polled at all.
         */
        function ChannelsPage() {
            var t = createTranslator();
            var statusState = React.useState(null);
            var status = statusState[0];
            var setStatus = statusState[1];
            var busyState = React.useState('');
            var busy = busyState[0];
            var setBusy = busyState[1];
            var errorState = React.useState('');
            var error = errorState[0];
            var setError = errorState[1];
            var nudgeState = React.useState(0);
            var nudge = nudgeState[0];
            var setNudge = nudgeState[1];

            var aliveRef = React.useRef(true);
            var timerRef = React.useRef(null);
            var abortRef = React.useRef(null);

            React.useEffect(function () {
                var stopped = false;
                aliveRef.current = true;

                function nextDelay() {
                    var hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
                    return hidden ? POLL_HIDDEN_MS : POLL_MS;
                }

                function schedule() {
                    if (stopped) return;
                    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
                    timerRef.current = window.setTimeout(tick, nextDelay());
                }

                function tick() {
                    if (stopped) return;
                    timerRef.current = null;
                    var controller = typeof AbortController === 'function' ? new AbortController() : null;
                    abortRef.current = controller;
                    fetch(ROUTES.status, {
                        cache: 'no-store',
                        signal: controller === null ? undefined : controller.signal,
                    })
                        .then(function (response) {
                            if (!response.ok) throw channelError('unavailable');
                            return response.json();
                        })
                        .then(function (projection) {
                            if (stopped) return;
                            if (projection !== null && typeof projection === 'object') setStatus(projection);
                            schedule();
                        })
                        .catch(function (failure) {
                            if (stopped) return;
                            if (failure !== null && failure.name === 'AbortError') return;
                            // The last projection stands: a page that cannot reach
                            // the Host must not invent a state it cannot see.
                            schedule();
                        });
                }

                tick();

                return function () {
                    stopped = true;
                    aliveRef.current = false;
                    if (timerRef.current !== null) {
                        window.clearTimeout(timerRef.current);
                        timerRef.current = null;
                    }
                    if (abortRef.current !== null) {
                        try {
                            abortRef.current.abort();
                        } catch (ignored) {
                            // An already-settled request needs no abort.
                        }
                        abortRef.current = null;
                    }
                };
            }, [nudge]);

            /** POST one action; a successful answer either folds or re-polls. */
            function post(path, body, platform) {
                if (busy !== '') return Promise.resolve();
                setBusy(platform);
                setError('');
                return fetch(path, {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                })
                    .then(function (response) {
                        return response.json().catch(function () { return null; }).then(function (payload) {
                            if (!response.ok) {
                                var code = payload !== null && typeof payload === 'object'
                                    && typeof payload.error === 'string'
                                    ? payload.error
                                    : 'unavailable';
                                throw channelError(code);
                            }
                            return payload;
                        });
                    })
                    .then(function (payload) {
                        if (!aliveRef.current) return;
                        if (payload !== null && typeof payload === 'object' && Array.isArray(payload.channels)) {
                            setStatus(payload);
                            return;
                        }
                        // `begin` answers an attempt id only, and 202 means the
                        // attempt started - not that anything is bound. Ask for
                        // the projection instead of guessing a phase.
                        setNudge(function (value) { return value + 1; });
                    })
                    .catch(function (failure) {
                        if (!aliveRef.current) return;
                        setError(errorText(t, failure !== null && typeof failure === 'object' ? failure.code : ''));
                    })
                    .then(function () {
                        if (aliveRef.current) setBusy('');
                    });
            }

            function begin(platform) {
                post(ROUTES.begin, { platform: platform }, platform);
            }

            function verify(platform, attemptId, code) {
                post(ROUTES.verifyCode, { platform: platform, attemptId: attemptId, code: code }, platform);
            }

            function select(platform, attemptId, accountId) {
                post(ROUTES.selectAccount, {
                    platform: platform,
                    attemptId: attemptId,
                    accountId: accountId,
                }, platform);
            }

            function cancel(platform, attemptId) {
                post(ROUTES.cancel, { platform: platform, attemptId: attemptId }, platform);
            }

            function disconnect(platform) {
                // Disconnecting a channel leaves the main assistant session and
                // everything it holds untouched.
                post(ROUTES.disconnect, { platform: platform }, platform);
            }

            function unbindGroup(platform, groupId) {
                // 群里会收到一句解绑确认；接回来只要跟助手说一句。
                post(ROUTES.groupUnbind, { groupId: groupId }, platform);
            }

            function card(platform, label, channel) {
                return h(ChannelCard, {
                    key: platform,
                    t: t,
                    platform: platform,
                    label: label,
                    channel: channel,
                    busy: busy !== '',
                    onBegin: begin,
                    onVerify: verify,
                    onSelect: select,
                    onCancel: cancel,
                    onDisconnect: disconnect,
                    onUnbindGroup: function (groupId) { unbindGroup(platform, groupId); },
                });
            }

            // 内置的两个平台总显示；插件登记的平台在 Host 的状态里有才显示，名字照登记时给的。
            var registered = status !== null && typeof status === 'object' && Array.isArray(status.channels)
                ? status.channels.filter(function (entry) {
                    return entry !== null && typeof entry === 'object' && entry.builtin !== true
                        && typeof entry.platform === 'string' && entry.platform !== '';
                })
                : [];

            return h('div', { className: 'cw-root' },
                h('p', { className: 'cw-muted' }, t('note')),
                card('qq', t('qq'), channelOf(status, 'qq')),
                card('weixin', t('weixin'), channelOf(status, 'weixin')),
                registered.map(function (entry) { return card(entry.platform, localized(t, entry.label, entry.platform), entry); }),
                error === '' ? null : h('p', { className: 'cw-err' }, error));
        }

        /**
         * Card styles, adapted from the MIT-licensed `dsh-channel-wechat` card.
         *
         * Only the grouped-inset card shell and the QR block are kept, expressed
         * in the theme's own tokens: no new theme, no new primitives, and the
         * controls themselves stay the shared `Button`/`Input`.
         */
        var CSS = [
            '.cw-root{display:flex;flex-direction:column;gap:28px;}',
            '.cw-card{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);overflow:hidden;}',
            '.cw-card-head{padding:20px 20px 4px;}',
            '.cw-card-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary);}',
            '.cw-card-body{display:flex;flex-direction:column;gap:14px;padding:12px 20px 20px;}',
            '.cw-muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;}',
            '.cw-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:13px;line-height:1.6;}',
            '.cw-err{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:1.6;}',
            '.cw-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}',
            '.cw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
            '.cw-groups{display:flex;flex-direction:column;gap:4px;}',
            '.cw-group-list{margin:0;padding-left:18px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;}',
            '.cw-group-item{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:2px 0;}',
            '.cw-qr-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:8px 0 4px;}',
            '.cw-qr{width:224px;height:224px;border-radius:var(--dsw-radius-lg);background:var(--dsw-static-neutral-00);padding:10px;box-sizing:border-box;box-shadow:var(--dsw-elevation-soft);}',
        ].join('');

        return {
            inject: ['slots'],
            apply: function (ctx) {
                // Tagged with the plugin id, so the loader removes the stylesheet
                // when the plugin is switched off; an untagged tag would outlive
                // the page it styles.
                ctx.effect(function () {
                    if (typeof document === 'undefined') return function () {};
                    var tag = document.createElement('style');
                    tag.dataset.plugin = PLUGIN_ID;
                    tag.dataset.pluginCss = PLUGIN_ID + '/client.js';
                    tag.textContent = CSS;
                    document.head.appendChild(tag);
                    return function () { tag.remove(); };
                }, 'galatea-channels: page styles');

                // The detail page renders exactly while this bundle is installed
                // and selected, and `plugins.bundle.config` is the slot it
                // reserves for the bundle's own page, keyed by the package name.
                ctx.effect(function () {
                    return ctx.slots.inject(SLOT, function () {
                        return ctx.slots.register({
                            name: SLOT,
                            key: PLUGIN_ID,
                        }, ChannelsPage);
                    });
                }, 'galatea-channels: detail page');
            },
        };
    },
});
