class PressThrottle {
  constructor(maxPerSecond) {
    this.maxPerSecond = maxPerSecond;
    this.timestamps = new Map();
  }

  allowPress(playerId) {
    const now = Date.now();
    if (!this.timestamps.has(playerId)) {
      this.timestamps.set(playerId, []);
    }
    this._cleanup(playerId, now);

    const playerTimestamps = this.timestamps.get(playerId);
    if (playerTimestamps.length >= this.maxPerSecond) {
      return false;
    }

    playerTimestamps.push(now);
    return true;
  }

  _cleanup(playerId, now) {
    const playerTimestamps = this.timestamps.get(playerId);
    if (!playerTimestamps) return;
    const cutoff = now - 1000;
    while (playerTimestamps.length > 0 && playerTimestamps[0] < cutoff) {
      playerTimestamps.shift();
    }
  }

  reset(playerId) {
    this.timestamps.delete(playerId);
  }
}

module.exports = PressThrottle;