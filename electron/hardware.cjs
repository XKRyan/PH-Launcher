const MODEL_FOOTPRINT_GB = {
  'qwen3.5:0.8b': 1.0,
  'qwen3.5:2b': 2.7,
  'qwen3.5:4b': 3.4,
  'qwen3.5:9b': 6.6,
};

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function recommendLocalModel(profile = {}) {
  const ramGb = numberOrZero(profile.ramGb);
  const vramGb = numberOrZero(profile.vramGb);
  const diskFreeGb = numberOrZero(profile.diskFreeGb);
  const diskKnown = diskFreeGb > 0;

  if (ramGb < 8) {
    return {
      recommended: false,
      model: '',
      label: '不建议运行本地 AI',
      reason: '这台电脑的内存不足 8 GB；建议保持关闭或改用可信的 API 服务。',
    };
  }

  if (diskKnown && diskFreeGb < 6) {
    return {
      recommended: false,
      model: '',
      label: '暂不建议安装本地模型',
      reason: '系统盘可用空间不足 6 GB；先清理空间，或在手动配置 Ollama 后连接已有模型。',
    };
  }

  if (ramGb >= 32 && vramGb >= 7.5 && (!diskKnown || diskFreeGb >= 9)) {
    const canOfferNineB = !diskKnown || diskFreeGb >= 16;
    return {
      recommended: true,
      model: 'qwen3.5:4b',
      ...(canOfferNineB ? { advancedModel: 'qwen3.5:9b' } : {}),
      label: canOfferNineB ? '推荐 Qwen3.5 4B；可选 9B' : '推荐 Qwen3.5 4B',
      reason: canOfferNineB
        ? '内存、显存与磁盘空间充足；4B 更流畅，9B 适合愿意等待更久的用户。'
        : '内存与显存充足；当前磁盘余量更适合安装 4B。',
    };
  }

  if (
    (ramGb >= 20 || (ramGb >= 16 && vramGb >= 6)) &&
    (!diskKnown || diskFreeGb >= 9)
  ) {
    return {
      recommended: true,
      model: 'qwen3.5:4b',
      label: '推荐 Qwen3.5 4B',
      reason: '这台电脑适合运行 4-bit 4B 模型，能兼顾中英文学习与响应速度。',
    };
  }

  if (ramGb >= 12 && (!diskKnown || diskFreeGb >= 8)) {
    return {
      recommended: true,
      model: 'qwen3.5:2b',
      label: '推荐 Qwen3.5 2B',
      reason: '优先保证 PH Launcher 与其他学习软件同时运行时保持流畅。',
    };
  }

  return {
    recommended: true,
    model: 'qwen3.5:0.8b',
    label: '仅推荐 Qwen3.5 0.8B',
    reason: '低配模式更稳妥；它适合短问答，但长文与复杂推理能力会受限。',
  };
}

module.exports = { MODEL_FOOTPRINT_GB, recommendLocalModel };
