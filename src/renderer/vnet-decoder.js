'use strict';

/**
 * VnetDecoder —— 把 uxplay `-vnet` 推来的 H264 裸码流解码成画面。
 *
 * 输入：一帧一个 access unit 的 **Annex-B** 字节（`00 00 01` 起始码）。
 *       引擎在每段会话的第一帧前会拼上 SPS/PPS（`prepend_sps_pps`），
 *       所以首帧必是 `SPS, PPS, IDR`；之后的帧只有 slice。
 * 输出：drawImage 到传入的 canvas。
 *
 * 为什么必须做 Annex-B → AVCC 的转换：
 *   WebCodecs 的 `avc1.*` 在给了 `description`（avcC）之后，输入必须是
 *   **4 字节长度前缀**的 AVCC 格式；直接喂起始码格式会被判为非法数据。
 *   avcC 又只能从 SPS/PPS 里拼 —— 所以这两件事是这个模块存在的主要理由。
 *
 * 几个实测踩出来的点（POC 阶段用 828 帧真机码流验证过）：
 *
 *   1. **SPS/PPS 整段只出现一次**。中途接入 / 断线重连后，必须用缓存的
 *      SPS/PPS 重新 configure，否则解码器起不来。这里做了缓存。
 *   2. **手机旋转会换 SPS**（宽高变）。检测到 SPS 内容变化就重建解码器，
 *      并把 canvas 一起改成新尺寸。
 *   3. **解码队列必须设上限**。渲染层跟不上时不能无限堆 EncodedVideoChunk，
 *      否则内存一路涨、延迟一路大。超过上限丢非关键帧，等下一个 IDR。
 *   4. **`0d0a` 不是坏数据**。H264 payload 里本来就可能出现这个字节序列，
 *      老版本 Winkow 用文本模式写 dump 才是真损坏的原因；这里按字节流处理，
 *      不做任何换行归一化。
 */

(function (root) {
  const HEADER_START = [0, 0, 1];

  // ---- Annex-B 拆包 ------------------------------------------------------
  /** 把一帧 Annex-B 数据拆成 NAL 列表（去掉起始码）。 */
  function splitNAL(buf) {
    const starts = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        starts.push(i);
        i += 2;
      }
    }
    if (!starts.length) return [];
    const nals = [];
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k];
      const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
      // 下一个起始码可能是 4 字节（00 00 00 01），尾部那个 00 属于起始码
      let e = end;
      while (e > s + 3 && buf[e - 1] === 0) e--;
      if (s + 3 < e) nals.push(buf.subarray(s + 3, e));
    }
    return nals;
  }

  /** 去掉 0x000003 防竞争字节。 */
  function unescapeRBSP(b) {
    const out = [];
    for (let i = 0; i < b.length; i++) {
      if (i + 2 < b.length && b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 3) {
        out.push(0, 0);
        i += 2;
      } else {
        out.push(b[i]);
      }
    }
    return new Uint8Array(out);
  }

  function BitReader(buf) {
    this.b = buf;
    this.pos = 0;
  }
  BitReader.prototype.bit = function () {
    const byte = this.b[this.pos >> 3];
    if (byte === undefined) throw new Error('eof');
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  };
  BitReader.prototype.bits = function (n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  };
  BitReader.prototype.ue = function () {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 32) throw new Error('bad ue');
    }
    return Math.pow(2, zeros) - 1 + this.bits(zeros);
  };
  BitReader.prototype.se = function () {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  };

  /**
   * 从 SPS NAL（含 1 字节 nal header）解出可见宽高。
   * 解不出来不算错误：宽高只用于给解码器一个提示和设置 canvas，
   * 真正的显示尺寸以解码输出的 displayWidth/Height 为准。
   */
  function parseSPS(nal) {
    const r = new BitReader(unescapeRBSP(nal.subarray(1)));
    const profile_idc = r.bits(8);
    r.bits(8);
    const level_idc = r.bits(8);
    r.ue(); // sps id
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile_idc) >= 0) {
      const chroma = r.ue();
      if (chroma === 3) r.bit();
      r.ue(); r.ue();
      r.bit();
      if (r.bit()) {
        const n = chroma === 3 ? 12 : 8;
        for (let i = 0; i < n; i++) {
          if (r.bit()) {
            let last = 8;
            let next = 8;
            const size = i < 6 ? 16 : 64;
            for (let j = 0; j < size; j++) {
              if (next !== 0) { const d = r.se(); next = (last + d + 256) % 256; }
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    r.ue(); // log2_max_frame_num
    const poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) {
      r.bit(); r.se(); r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue(); // ref frames
    r.bit();
    const wMbs = r.ue() + 1;
    const hMap = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    const crop = r.bit()
      ? { l: r.ue(), r: r.ue(), t: r.ue(), b: r.ue() }
      : { l: 0, r: 0, t: 0, b: 0 };
    return {
      profile: profile_idc,
      level: level_idc,
      width: wMbs * 16 - (crop.l + crop.r) * 2,
      height: (2 - frameMbsOnly) * hMap * 16 - (crop.t + crop.b) * 2
    };
  }

  /** 拼 avcC（AVCDecoderConfigurationRecord）。 */
  function buildAvcC(sps, pps) {
    const out = new Uint8Array(11 + sps.length + pps.length);
    let o = 0;
    out[o++] = 1;              // configurationVersion
    out[o++] = sps[1];         // AVCProfileIndication
    out[o++] = sps[2];         // profile_compatibility
    out[o++] = sps[3];         // AVCLevelIndication
    out[o++] = 0xff;           // 6 bits reserved + lengthSizeMinusOne = 3
    out[o++] = 0xe1;           // 3 bits reserved + numOfSequenceParameterSets = 1
    out[o++] = (sps.length >> 8) & 0xff;
    out[o++] = sps.length & 0xff;
    out.set(sps, o); o += sps.length;
    out[o++] = 1;              // numOfPictureParameterSets
    out[o++] = (pps.length >> 8) & 0xff;
    out[o++] = pps.length & 0xff;
    out.set(pps, o);
    return out;
  }

  /** 同样的 SPS/PPS 就复用配置，避免每帧都重建解码器。 */
  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---- 解码器本体 --------------------------------------------------------

  /**
   * @param {Object} opts
   *   canvas       目标 canvas
   *   onSize(w,h)  真实像素尺寸变化时回调（用于把浮窗调成同一比例）
   *   onFrame()    每解出一帧就回调一次（尺寸没变也调）。停帧把画面收起来之后，
   *                只有它能告诉我们「画面又回来了」—— 尺寸不变时 onSize 不会触发
   *   onState(s)   状态文本：'waiting' | 'decoding' | 'error' | 'unsupported'
   *   onStats(o)   统计快照
   *   maxQueue     解码队列上限，超过就丢非关键帧（默认 8）
   */
  function VnetDecoder(opts) {
    const o = opts || {};
    this.canvas = o.canvas || null;
    this.ctx = this.canvas ? this.canvas.getContext('2d', { alpha: false }) : null;
    this.onSize = typeof o.onSize === 'function' ? o.onSize : function () {};
    this.onFrame = typeof o.onFrame === 'function' ? o.onFrame : function () {};
    this.onState = typeof o.onState === 'function' ? o.onState : function () {};
    this.onStats = typeof o.onStats === 'function' ? o.onStats : function () {};
    this.maxQueue = o.maxQueue > 0 ? o.maxQueue : 8;

    this.decoder = null;
    this.sps = null;
    this.pps = null;
    this.configKey = '';
    this.ready = false;
    this.size = { w: 0, h: 0 };
    this.state = 'waiting';

    this.decoded = 0;
    this.drawn = 0;
    this.dropped = 0;
    this.errors = 0;
    this.waitingFrames = 0;   // 还没拿到 SPS 时暂存的帧数
    this.backlog = 0;         // 解码队列积压峰值（诊断「卡顿」用）
    this._pending = null;     // 待绘制的帧（只保留最新一张）
    this._raf = 0;
    this._tsBase = 0;         // 会话内第一帧的时间戳，之后都换算成相对值
    this._lastTs = -1;
    this._fpsWin = 0;
    this._fpsAt = Date.now();
    this.dps = 0;
    this.destroyed = false;
    this._capabilities = null;
  }

  VnetDecoder.prototype.capable = function () {
    return typeof root.VideoDecoder !== 'undefined' && typeof root.EncodedVideoChunk !== 'undefined';
  };

  VnetDecoder.prototype._setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  };

  /** 一帧进来。data 必须是 Uint8Array（IPC 过来的就是）。 */
  VnetDecoder.prototype.push = function (data, ts) {
    if (this.destroyed || !data || !data.length) return;
    if (!this.capable()) { this._setState('unsupported'); return; }

    const nals = splitNAL(data);
    if (!nals.length) return;

    let sps = null;
    let pps = null;
    let isKey = false;
    for (let i = 0; i < nals.length; i++) {
      const t = nals[i][0] & 0x1f;
      if (t === 7) sps = nals[i];
      else if (t === 8) pps = nals[i];
      else if (t === 5) isKey = true;
    }

    // SPS 出现 = 一段新码流的开始。
    //
    // 引擎只在每段会话的首帧前拼 SPS/PPS（`prepend_sps_pps`），所以看到 SPS
    // 就意味着：手机重新投屏了，或者引擎重启后 VnetSource 重新连上了。
    //
    // 这时**必须重建解码器**，不管 SPS 内容有没有变 —— 用户遇到的就是「同机型
    // 同分辨率重连，SPS 一个字节都没变」的情况：如果按「内容变了才重建」判断，
    // 就会继续用那个参考帧已经全部作废的旧解码器，后面每一帧 P 帧都解错，
    // 表现为花屏或者干脆不出画面，只能重启 Winkow。
    if (sps) {
      this.sps = sps;
      if (pps) this.pps = pps;
      // 新会话 = 新的一段时间轴。把基准清零，否则旧会话残留的"最后时间戳"
      // 会一路 +1ms 追着跑，几十秒内每帧都只差 1ms，播放节奏彻底乱掉。
      this._tsBase = 0;
      this._lastTs = -1;
      if (this.pps) this._reconfigure(true);
    } else if (pps) {
      this.pps = pps;
      if (this.sps && !this.ready) this._reconfigure(true);
    }

    if (!this.ready) {
      // 还没有 SPS/PPS 就没法 configure。引擎会在会话首帧前拼上它们，
      // 所以这里正常只会短暂等待；留一个计数便于诊断「到底收到了什么」。
      if (!this.sps || !this.pps) {
        this.waitingFrames += 1;
        this._setState('waiting');
        this._emitStats();
        return;
      }
      this._reconfigure(true);
      if (!this.ready) return;
    }

    /* 这里**绝不丢 P 帧**。
     *
     * 曾经的做法是「队列超过 8 就丢非关键帧」，看着像个合理的削峰手段，
     * 实际是花屏的根源：AirPlay 整段会话只有开头 1 个 IDR，后面全是 P 帧，
     * 而每个 P 帧都依赖它前面那些帧。丢掉任何一帧，后面的参考链就断了，
     * 而且等不到下一个 IDR 来修复 —— 一旦丢帧，画面就烂到会话结束。
     *
     * 解码跟不上时的正确做法是「画」跳帧（见 _drawPending），不是「解」跳帧。
     * 解码本身很快，真正的瓶颈通常在 drawImage 和跨进程搬运上。
     */
    if (this.decoder.decodeQueueSize > this.backlog) this.backlog = this.decoder.decodeQueueSize;

    const avcc = this._toAvcc(nals);
    if (!avcc) return;

    let stamp = Number(ts);
    if (!isFinite(stamp) || stamp < 0) stamp = this._lastTs < 0 ? 0 : this._lastTs;
    // 换成「相对会话首帧」的毫秒值：NTP 纪元差的 70 年会把它变成天文数字，
    // WebCodecs 的时间戳是 int64 微秒，没必要冒这个险
    if (this._tsBase === 0) this._tsBase = stamp;
    stamp -= this._tsBase;
    if (stamp < 0) stamp = 0;
    // WebCodecs 要求时间戳严格非递减；引擎 NTP 偶发回绕时兜一下
    if (this._lastTs >= 0 && stamp <= this._lastTs) stamp = this._lastTs + 1;
    this._lastTs = stamp;

    try {
      this.decoder.decode(new root.EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: Math.round(stamp * 1000), // 毫秒 -> 微秒
        data: avcc
      }));
      this._setState('decoding');
    } catch (err) {
      /* 解码器已经不可用（configure 失败 / 被关闭 / 上一次 error 回调把它收掉了）。
       *
       * 关键：**这一帧不能随手丢掉**。如果它正好是新会话的首帧，SPS/PPS 就
       * 在它身上 —— 丢了就再也等不到参数集，画面永远起不来（用户看到的就是
       * 「必须重启 Winkow」）。所以重建之后把这一帧重试一次。
       */
      this.errors += 1;
      this._teardownDecoder();
      this._setState('error');
      if (this.sps && this.pps) {
        this._reconfigure(true);
        if (this.ready && this._retryAvcc(avcc, isKey, stamp)) this._setState('decoding');
      }
    }
    this._emitStats();
  };

  /** decode() 抛错后，用新建的解码器把同一帧再送一次。 */
  VnetDecoder.prototype._retryAvcc = function (avcc, isKey, stamp) {
    try {
      this.decoder.decode(new root.EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: Math.round(stamp * 1000),
        data: avcc
      }));
      return true;
    } catch (_) {
      this._teardownDecoder();
      return false;
    }
  };

  /** NAL 列表 -> AVCC（每段 4 字节长度前缀）。 */
  VnetDecoder.prototype._toAvcc = function (nals) {
    let total = 0;
    for (let i = 0; i < nals.length; i++) total += 4 + nals[i].length;
    const out = new Uint8Array(total);
    let o = 0;
    for (let i = 0; i < nals.length; i++) {
      const n = nals[i];
      out[o] = (n.length >>> 24) & 0xff;
      out[o + 1] = (n.length >>> 16) & 0xff;
      out[o + 2] = (n.length >>> 8) & 0xff;
      out[o + 3] = n.length & 0xff;
      o += 4;
      out.set(n, o);
      o += n.length;
    }
    return out;
  };

  /**
   * @param {boolean} force 忽略「配置没变就复用」的短路。
   *   会话边界（收到 SPS）和"解码器挂了要重建"这两种情况必须给 true,
   *   否则会复用那个已经解不出画面的旧实例 —— 这正是「重连后必须重启」的成因。
   */
  VnetDecoder.prototype._reconfigure = function (force) {
    if (!this.sps || !this.pps) return;
    const avcC = buildAvcC(this.sps, this.pps);
    const key = this.sps[1] + ':' + this.sps[2] + ':' + this.sps[3] + ':' + this.sps.length + ':' + this.pps.length;
    if (!force && key === this.configKey && this.ready) return;

    let geom = { width: 0, height: 0 };
    try { geom = parseSPS(this.sps); } catch (_) {}

    const codec = 'avc1.' + [this.sps[1], this.sps[2], this.sps[3]]
      .map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');

    this._teardownDecoder();

    const self = this;
    const cfg = { codec: codec, description: avcC, optimizeForLatency: true };
    if (geom.width > 0 && geom.height > 0) {
      cfg.codedWidth = geom.width;
      cfg.codedHeight = geom.height;
    }

    let decoder;
    try {
      decoder = new root.VideoDecoder({
        output: function (frame) { self._onSample(frame); },
        error: function () {
          self.errors += 1;
          self._teardownDecoder();
          self._setState('error');
          self._emitStats();
        }
      });
      decoder.configure(cfg);
    } catch (err) {
      this.errors += 1;
      this._setState('error');
      try { if (decoder) decoder.close(); } catch (_) {}
      return;
    }

    this.decoder = decoder;
    this.configKey = key;
    this.ready = true;
    this.codec = codec;
    this._lastTs = -1;
  };

  VnetDecoder.prototype._teardownDecoder = function () {
    const d = this.decoder;
    this.decoder = null;
    this.ready = false;
    this.configKey = '';
    if (!d) return;
    try { if (d.state !== 'closed') d.close(); } catch (_) {}
  };

  /**
   * 解码输出回调：**只登记最新一帧，不直接画**。
   *
   * 这里是「解」与「画」解耦的关键。解码必须逐帧走完（P 帧参考链不能断），
   * 但绘制是纯显示行为，中间帧错过就错过了 —— 屏幕上永远只该出现最新的一帧。
   * 如果每帧都同步 drawImage，渲染线程一忙就会反压解码队列，于是要么卡顿、
   * 要么（老代码）丢帧导致花屏。放到 rAF 里画，等于自动跟随显示器刷新率。
   */
  VnetDecoder.prototype._onSample = function (frame) {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;

    this.decoded += 1;
    this._fpsWin += 1;

    // 尺寸变化（手机旋转 / 换了设备）要立刻上报，不能等绘制 ——
    // 做主进程那边调窗口比例要靠它，跟 rAF 有没有触发无关
    if (w > 0 && h > 0 && (w !== this.size.w || h !== this.size.h)) {
      this.size = { w: w, h: h };
      this.rotated = true;
      this.onSize(w, h);
    } else {
      /* 尺寸没变时也要报一声：停帧兜底会把画面收成「等待设备」，
       * 恢复时尺寸当然还是原来的尺寸，只有这条能把它切回画面。
       * 回调方自己保证「已经显示」时立刻返回，成本就是一次函数调用。 */
      this.onFrame();
    }

    // 只留最新一帧：没画出去的旧帧直接关掉，否则 VideoFrame 会一直占着解码器池
    if (this._pending) { try { this._pending.close(); } catch (_) {} }
    this._pending = frame;
    this._scheduleDraw();
    this._emitStats();
  };

  VnetDecoder.prototype._scheduleDraw = function () {
    if (this._raf) return;
    const self = this;
    const raf = root.requestAnimationFrame
      ? function (cb) { return root.requestAnimationFrame(cb); }
      : function (cb) { return setTimeout(cb, 16); };
    this._raf = raf(function () { self._raf = 0; self._drawPending(); });
  };

  VnetDecoder.prototype._drawPending = function () {
    const frame = this._pending;
    this._pending = null;
    if (!frame) return;
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (this.canvas && w > 0 && h > 0) {
      // 只在尺寸真的变了才改 canvas：改 width/height 会清空并重建后备缓冲
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      try { this.ctx.drawImage(frame, 0, 0, w, h); } catch (_) {}
    }
    try { frame.close(); } catch (_) {}
    this.drawn += 1;
  };

  VnetDecoder.prototype._emitStats = function () {
    const now = Date.now();
    if (now - this._fpsAt >= 500) {
      this.dps = Math.round((this._fpsWin * 1000 / (now - this._fpsAt)) * 10) / 10;
      this._fpsWin = 0;
      this._fpsAt = now;
    }
    this.onStats({
      state: this.state,
      decoded: this.decoded,
      drawn: this.drawn,
      dropped: this.dropped,
      errors: this.errors,
      waiting: this.waitingFrames,
      backlog: this.backlog,
      fps: this.dps,
      width: this.size.w,
      height: this.size.h,
      codec: this.codec || '',
      queue: this.decoder ? this.decoder.decodeQueueSize : 0
    });
  };

  /** 手机断开 / 换设备：清掉解码器与缓存的参数集，回到等 SPS 的状态。 */
  VnetDecoder.prototype.reset = function () {
    this._teardownDecoder();
    this._clearPending();
    this.sps = null;
    this.pps = null;
    this.size = { w: 0, h: 0 };
    this.decoded = 0;
    this.drawn = 0;
    this.dropped = 0;
    this.errors = 0;
    this.waitingFrames = 0;
    this.backlog = 0;
    this._tsBase = 0;
    this._lastTs = -1;
    this._setState('waiting');
  };

  VnetDecoder.prototype._clearPending = function () {
    if (this._raf) {
      const caf = root.cancelAnimationFrame;
      if (caf) { try { caf(this._raf); } catch (_) {} }
      this._raf = 0;
    }
    if (this._pending) { try { this._pending.close(); } catch (_) {} this._pending = null; }
  };

  VnetDecoder.prototype.destroy = function () {
    this.destroyed = true;
    this._teardownDecoder();
    this._clearPending();
    this.canvas = null;
    this.ctx = null;
  };

  root.VnetDecoder = VnetDecoder;
  // 供 Node 侧单测直接 require（页面里没有 module）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VnetDecoder: VnetDecoder, splitNAL: splitNAL, parseSPS: parseSPS, buildAvcC: buildAvcC };
  }
})(typeof self !== 'undefined' ? self : this);
