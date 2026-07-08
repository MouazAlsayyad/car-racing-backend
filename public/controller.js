class Controller {
  constructor() {
    this.ws = null;
    this.playerId = null;
    this.roomCode = '';
    this.playerName = '';
    this.isHost = false;
    this.selectedCarId = 1;
    this.assignedCarId = null;
    this.client_seq = 0;
    this.pressCount = 0;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.reconnectTimer = null;
    this.isRacing = false;
    this.takenCarIds = new Set();

    this._bindElements();
    this._bindEvents();
    this._loadSavedState();
  }

  _bindElements() {
    this.joinScreen = document.getElementById('join-screen');
    this.waitingScreen = document.getElementById('waiting-screen');
    this.raceScreen = document.getElementById('race-screen');
    this.resultScreen = document.getElementById('result-screen');

    this.roomCodeInput = document.getElementById('room-code-input');
    this.playerNameInput = document.getElementById('player-name-input');
    this.joinButton = document.getElementById('join-button');
    this.joinError = document.getElementById('join-error');

    this.roomCodeDisplay = document.getElementById('room-code-display');
    this.statusLabel = document.getElementById('status-label');
    this.playerListEl = document.getElementById('player-list');
    this.startButton = document.getElementById('start-button');

    this.carOptions = document.querySelectorAll('.car-option');

    this.tapButton = document.getElementById('tap-button');
    this.tapLabel = document.getElementById('tap-label');
    this.pressCounterEl = document.getElementById('press-counter');

    this.rankingsList = document.getElementById('rankings-list');
  }

  _bindEvents() {
    this.joinButton.addEventListener('click', () => this._onJoin());
    this.startButton.addEventListener('click', () => this._onStart());

    this.tapButton.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._onTap();
    }, { passive: false });

    this.tapButton.addEventListener('mousedown', (e) => {
      if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
      this._onTap();
    });

    this.roomCodeInput.addEventListener('input', () => {
      this.roomCodeInput.value = this.roomCodeInput.value.toUpperCase();
    });

    this.playerNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._onJoin();
    });

    this.roomCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.playerNameInput.focus();
    });

    this.carOptions.forEach((option) => {
      option.addEventListener('click', () => {
        const carId = parseInt(option.dataset.carId, 10);
        this._selectCar(carId);
      });
    });
  }

  _loadSavedState() {
    try {
      const saved = localStorage.getItem('car_racing_state');
      if (saved) {
        const state = JSON.parse(saved);
        if (state.playerId && state.roomCode) {
          this.playerId = state.playerId;
          this.roomCode = state.roomCode;
          this.playerName = state.playerName || '';
          this.isHost = state.isHost || false;
          this.assignedCarId = state.carId || null;
          this.connect();
          return;
        }
      }
    } catch (e) {
      // ignore
    }
    this.connect();
  }

  _saveState() {
    try {
      localStorage.setItem('car_racing_state', JSON.stringify({
        playerId: this.playerId,
        roomCode: this.roomCode,
        playerName: this.playerName,
        isHost: this.isHost,
        carId: this.assignedCarId,
      }));
    } catch (e) {
      // ignore
    }
  }

  _clearState() {
    try {
      localStorage.removeItem('car_racing_state');
    } catch (e) {
      // ignore
    }
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;

      if (this.playerId && this.roomCode) {
        this._sendRejoin();
      }
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      this._routeMessage(msg);
    };

    this.ws.onclose = () => {
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  _routeMessage(msg) {
    switch (msg.type) {
      case 'joined':
        this.onJoined(msg);
        break;
      case 'player_list':
        this.onPlayerList(msg);
        break;
      case 'player_promoted':
        this.onPlayerPromoted(msg);
        break;
      case 'game_start':
        this.onGameStart(msg);
        break;
      case 'press_ack':
        this.onPressAck(msg);
        break;
      case 'room_snapshot':
        this.onRoomSnapshot(msg);
        break;
      case 'result':
        this.onResult(msg);
        break;
      case 'error':
        this.onError(msg);
        break;
      case 'room_closed':
        this.onRoomClosed();
        break;
      case 'state_change':
        if (msg.state === 'RACING') {
          this.onGameStart(msg);
        }
        break;
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _onJoin() {
    const roomCode = (this.roomCodeInput.value || '').trim().toUpperCase();
    const playerName = (this.playerNameInput.value || '').trim();

    this.joinError.textContent = '';

    if (!roomCode || roomCode.length < 2) {
      this.joinError.textContent = 'Enter a valid room code';
      return;
    }
    if (!playerName) {
      this.joinError.textContent = 'Enter your name';
      return;
    }

    this.roomCode = roomCode;
    this.playerName = playerName;

    this._send({
      type: 'join',
      roomCode: roomCode,
      playerName: playerName,
      carId: this.selectedCarId,
    });
  }

  _selectCar(carId) {
    if (this.takenCarIds.has(carId)) return;
    this.selectedCarId = carId;
    this._updateCarSelector();
  }

  _updateCarSelector() {
    this.carOptions.forEach((option) => {
      const carId = parseInt(option.dataset.carId, 10);
      option.classList.toggle('selected', carId === this.selectedCarId);
      option.classList.toggle('taken', this.takenCarIds.has(carId));
    });
  }

  _sendRejoin() {
    if (!this.playerId || !this.roomCode) return;
    this._send({
      type: 'rejoin',
      roomCode: this.roomCode,
      playerId: this.playerId,
    });
  }

  _onStart() {
    if (!this.isHost) return;
    this._send({
      type: 'start',
      roomCode: this.roomCode,
      playerId: this.playerId,
    });
  }

  _onTap() {
    if (!this.isRacing) return;
    this.pressCount++;
    this.pressCounterEl.textContent = this.pressCount;
    this._send({
      type: 'press',
      roomCode: this.roomCode,
      playerId: this.playerId,
      client_seq: this.clientSeq++,
      client_ts: new Date().toISOString(),
    });
  }

  // --- Message handlers ---

  onJoined(msg) {
    this.playerId = msg.playerId;
    this.isHost = msg.isHost;
    this.assignedCarId = msg.carId || this.selectedCarId;
    this.roomCode = msg.roomCode || this.roomCode;
    this._saveState();

    this.roomCodeDisplay.textContent = this.roomCode;
    this._updateStartButton();
    this.statusLabel.textContent = this.isHost
      ? 'You are the host. Waiting for players...'
      : 'Waiting for host to start...';
    this._showScreen('waiting');
  }

  onPlayerList(msg) {
    this.takenCarIds.clear();
    for (const player of msg.players) {
      if (player.carId) {
        this.takenCarIds.add(player.carId);
      }
    }
    if (!this.assignedCarId) {
      if (this.takenCarIds.has(this.selectedCarId)) {
        for (let i = 1; i <= 4; i++) {
          if (!this.takenCarIds.has(i)) {
            this.selectedCarId = i;
            break;
          }
        }
      }
      this._updateCarSelector();
    }
    this._renderPlayerList(msg.players);
  }

  onPlayerPromoted(msg) {
    if (msg.playerId === this.playerId) {
      this.isHost = true;
      this._saveState();
    }
    this._updateStartButton();
    this.statusLabel.textContent = this.isHost
      ? 'You are the host. Tap Start when ready!'
      : 'Waiting for host to start...';
  }

  onGameStart(msg) {
    this.isRacing = true;
    this.pressCount = 0;
    this.clientSeq = 0;
    this.pressCounterEl.textContent = '0';
    this.tapLabel.textContent = 'TAP!';

    this.tapButton.classList.remove('disabled');
    this.tapButton.classList.remove('throttled');

    this._showScreen('race');
  }

  onRoomClosed() {
    this._clearState();
    this.playerId = null;
    this.isHost = false;
    this.isRacing = false;
    this.pressCount = 0;
    this.clientSeq = 0;
    this.roomCode = '';
    this.assignedCarId = null;
    this.takenCarIds.clear();
    this.selectedCarId = 1;
    this._updateCarSelector();

    this.pressCounterEl.textContent = '0';
    this.tapButton.classList.add('disabled');
    this.tapButton.classList.remove('throttled');

    this._showScreen('join');
  }

  onPressAck(msg) {
    if (msg.accepted) {
      this.tapButton.style.background = '';
      setTimeout(() => {
        if (this.tapButton.classList.contains('throttled')) return;
      }, 50);
    } else if (msg.reason === 'throttled') {
      this.tapButton.classList.add('throttled');
      setTimeout(() => {
        this.tapButton.classList.remove('throttled');
      }, 150);
    }
  }

  onRoomSnapshot(msg) {
    this._showScreen('waiting');
    this.roomCodeDisplay.textContent = this.roomCode;
    if (msg.playerDistances) {
      const names = Object.keys(msg.playerDistances);
      if (names.length > 0) {
        this.statusLabel.textContent = 'Reconnected! Race in progress...';
      }
    }
  }

  onResult(msg) {
    this.isRacing = false;
    this.tapButton.classList.add('disabled');

    const rankings = msg.rankings || [];
    this.rankingsList.innerHTML = '';

    rankings.forEach((entry, i) => {
      const el = document.createElement('div');
      el.className = 'ranking-entry' + (i === 0 ? ' first' : '');

      const pos = document.createElement('span');
      pos.className = 'ranking-position';
      pos.textContent = `${i + 1}.`;

      const name = document.createElement('span');
      name.className = 'ranking-name';
      name.textContent = entry.name || entry.playerId;

      const dist = document.createElement('span');
      dist.className = 'ranking-distance';
      dist.textContent = `${Math.round(entry.distance)}m`;

      el.appendChild(pos);
      el.appendChild(name);
      el.appendChild(dist);
      this.rankingsList.appendChild(el);
    });

    this._showScreen('result');
  }

  onError(msg) {
    const message = msg.message || 'Unknown error';

    if (message === 'invalid_room' || message === 'room_code_unavailable') {
      this.joinError.textContent = 'Room not found. Check the code and try again.';
      this._showScreen('join');
    } else if (message === 'not_host') {
      this.statusLabel.textContent = 'Only the host can start the race.';
    } else if (message === 'room_full') {
      this.joinError.textContent = 'Room is full. Try another room.';
      this._showScreen('join');
    } else if (message === 'malformed_message') {
      // handled internally, usually recoverable
    } else {
      this.joinError.textContent = message;
    }
  }

  // --- UI helpers ---

  _showScreen(id) {
    const screens = {
      join: this.joinScreen,
      waiting: this.waitingScreen,
      race: this.raceScreen,
      result: this.resultScreen,
    };

    for (const [key, el] of Object.entries(screens)) {
      if (key === id) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  }

  _renderPlayerList(players) {
    this.playerListEl.innerHTML = '';

    for (const player of players) {
      const el = document.createElement('div');
      el.className = 'player-entry';

      const icon = document.createElement('img');
      icon.className = 'player-car-icon';
      icon.src = `/cars/car_${player.carId || 1}.png`;
      icon.alt = `Car ${player.carId || 1}`;
      icon.draggable = false;

      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = player.name || player.id;

      el.appendChild(icon);
      el.appendChild(name);

      if (player.isHost) {
        const badge = document.createElement('span');
        badge.className = 'host-badge';
        badge.textContent = 'HOST';
        el.appendChild(badge);
      }

      this.playerListEl.appendChild(el);
    }

    this._updateStartButton();
  }

  _updateStartButton() {
    if (this.isHost) {
      this.startButton.classList.remove('hidden');
    } else {
      this.startButton.classList.add('hidden');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new Controller();
});