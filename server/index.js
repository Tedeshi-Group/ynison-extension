const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 10001;
const PROTOCOL_VERSION = 1;
const EMPTY_ROOM_TTL_MS = 30_000;

const rooms = new Map();

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function send(member, type, payload) {
  const envelope = {
    type,
    roomId: member.roomId,
    ts: Date.now(),
    v: PROTOCOL_VERSION,
    payload,
  };
  if (member.socket && member.socket.readyState === 1) {
    member.socket.send(JSON.stringify(envelope));
    return;
  }
  if (!member.inbox) {
    member.inbox = [];
  }
  member.inbox.push(envelope);
  if (typeof member.flush === 'function') {
    const flush = member.flush;
    member.flush = null;
    flush();
  }
}

function permissionsFor(member) {
  const isHost = member.role === 'host';
  const canControl = isHost || member.canControl;
  return {
    canControl,
    canDelegate: isHost,
    canControlPlayback: canControl,
    canPassControl: isHost,
  };
}

function participantList(room) {
  return [...room.members.values()].map((member) => ({
    clientId: member.clientId,
    nickname: member.nickname || 'Гость',
    avatarUrl: member.avatarUrl || '',
    role: member.role,
    isConnected: true,
    canControl: member.role === 'host' || member.canControl,
  }));
}

function roomSnapshot(room, member) {
  const snapshot = {
    id: room.id,
    roomId: room.id,
    hostClientId: room.hostClientId,
    participants: participantList(room),
    permissions: permissionsFor(member),
    participantRole: member.role,
    role: member.role,
    updatedAt: room.updatedAt,
  };
  if (room.track) {
    snapshot.track = room.track;
    snapshot.currentTrack = room.track;
  }
  if (room.playback) {
    snapshot.playbackState = room.playback;
    snapshot.playback = room.playback;
    snapshot.trackState = room.playback;
  }
  if (room.stateVersion > 0) {
    snapshot.stateVersion = room.stateVersion;
  }
  return snapshot;
}

function sendConnected(member, room) {
  send(member, 'CONNECTED', {
    clientId: member.clientId,
    role: member.role,
    roleHint: member.role,
    permissions: permissionsFor(member),
    roomState: roomSnapshot(room, member),
  });
}

function broadcastParticipants(room) {
  for (const member of room.members.values()) {
    send(member, 'ROOM_PARTICIPANTS', {
      participants: participantList(room),
    });
  }
}

function rememberVersion(room, payload) {
  const incoming = Number(payload && (payload.stateVersion ?? payload.state?.stateVersion));
  if (Number.isFinite(incoming) && incoming > room.stateVersion) {
    room.stateVersion = incoming;
  }
  room.updatedAt = Date.now();
}

function broadcastExcept(room, type, payload, exceptClientId) {
  let sent = 0;
  for (const member of room.members.values()) {
    if (member.clientId === exceptClientId) {
      continue;
    }
    send(member, type, payload);
    sent += 1;
  }
  if (sent > 0) {
    console.log(`[рассылка] ${type} из комнаты ${room.id} ушло ${sent} участникам`);
  }
}

function closeRoom(room, reason) {
  for (const member of room.members.values()) {
    send(member, 'ROOM_CLOSED', { reason: reason || 'closed' });
    try {
      member.socket.close(1000, reason || 'closed');
    } catch (_error) {
      // Сокет уже закрыт.
    }
  }
  rooms.delete(room.id);
}

function removeMember(room, clientId, options = {}) {
  const member = room.members.get(clientId);
  if (!member) {
    return;
  }
  room.members.delete(clientId);
  if (options.notifyClosed) {
    send(member, 'ROOM_CLOSED', { reason: options.reason || 'kicked' });
  }
  try {
    member.socket.close(1000, options.reason || 'leave');
  } catch (_error) {
    // Сокет уже закрыт.
  }

  if (room.members.size === 0) {
    room.emptySince = Date.now();
    return;
  }

  room.emptySince = 0;
  if (room.hostClientId === clientId) {
    closeRoom(room, 'host_left');
    return;
  }
  broadcastParticipants(room);
}

function hostMember(room) {
  return room.members.get(room.hostClientId) || null;
}

function onClientMessage(member, room, message) {
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch (_error) {
    send(member, 'ERROR', { message: 'Не получилось прочитать сообщение' });
    return;
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.type) {
    return;
  }
  if (parsed.roomId && parsed.roomId !== room.id) {
    return;
  }

  const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
  console.log(`[сообщение] ${member.clientId} прислал ${parsed.type} в комнату ${room.id}`);

  switch (parsed.type) {
    case 'HELLO': {
      if (payload.nickname) {
        member.nickname = String(payload.nickname).slice(0, 80);
      }
      if (typeof payload.avatarUrl === 'string') {
        member.avatarUrl = payload.avatarUrl.slice(0, 500);
      }
      broadcastParticipants(room);
      break;
    }
    case 'TRACK_INFO':
    case 'PLAYBACK_STATE': {
      if (member.role !== 'host') {
        send(member, 'ERROR', { message: 'Песню может присылать только хозяин комнаты' });
        return;
      }
      if (parsed.type === 'TRACK_INFO') {
        const track = payload.track || payload.currentTrack || null;
        if (track) {
          room.track = track;
        }
        if (payload.state) {
          room.playback = payload.state;
        }
      } else if (payload.state) {
        room.playback = payload.state;
        if (payload.currentTrack && payload.currentTrack.trackId) {
          room.track = { ...(room.track || {}), ...payload.currentTrack };
        }
      }
      rememberVersion(room, payload);
      broadcastExcept(room, parsed.type, payload, member.clientId);
      break;
    }
    case 'COMMAND_REQUEST': {
      if (payload.action === 'closeRoom') {
        if (member.role !== 'host') {
          send(member, 'ERROR', { message: 'Закрыть комнату может только хозяин' });
          return;
        }
        closeRoom(room, 'closed');
        return;
      }
      if (payload.action === 'kick') {
        if (member.role !== 'host') {
          send(member, 'ERROR', { message: 'Выгнать может только хозяин' });
          return;
        }
        const targetId = String(payload.targetClientId || '');
        if (targetId && targetId !== room.hostClientId) {
          removeMember(room, targetId, { notifyClosed: true, reason: 'kicked' });
        }
        return;
      }
      const host = hostMember(room);
      if (!host) {
        send(member, 'ERROR', { message: 'Хозяин комнаты сейчас не в сети' });
        return;
      }
      if (member.clientId === host.clientId) {
        return;
      }
      send(host, 'COMMAND_TO_HOST', payload);
      break;
    }
    case 'CONTROL_TRANSFER': {
      if (member.role !== 'host') {
        send(member, 'ERROR', { message: 'Передавать управление может только хозяин' });
        return;
      }
      const target = room.members.get(String(payload.targetClientId || ''));
      if (!target) {
        return;
      }
      target.canControl = Boolean(payload.canControl);
      send(target, 'CONTROL_GRANTED', {
        role: target.role,
        permissions: permissionsFor(target),
      });
      broadcastParticipants(room);
      break;
    }
    case 'LEAVE':
      removeMember(room, member.clientId);
      break;
    default:
      break;
  }
}

function attachClient(socket, req) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const roomId = String(url.searchParams.get('roomId') || '').trim();
  const clientId = String(url.searchParams.get('clientId') || '').trim();
  const roleHint = url.searchParams.get('roleHint') || url.searchParams.get('role') || 'listener';

  if (!roomId || !clientId) {
    socket.close(1008, 'roomId and clientId are required');
    return;
  }

  let room = rooms.get(roomId);
  const wantsHost = roleHint === 'host';

  if (!room) {
    if (!wantsHost) {
      socket.send(JSON.stringify({
        type: 'ERROR',
        roomId,
        ts: Date.now(),
        v: PROTOCOL_VERSION,
        payload: { message: 'Комната не найдена. Попроси ссылку у того, кто её создал.' },
      }));
      socket.close(1008, 'room not found');
      return;
    }
    room = {
      id: roomId,
      hostClientId: clientId,
      members: new Map(),
      track: null,
      playback: null,
      stateVersion: 0,
      updatedAt: Date.now(),
      emptySince: 0,
    };
    rooms.set(roomId, room);
  }

  const previous = room.members.get(clientId);
  if (previous && previous.socket !== socket) {
    try {
      previous.socket.close(4000, 'replaced');
    } catch (_error) {
      // Старое соединение уже закрыто.
    }
    room.members.delete(clientId);
  }

  const role = wantsHost && (room.members.size === 0 || room.hostClientId === clientId)
    ? 'host'
    : 'listener';
  if (role === 'host') {
    room.hostClientId = clientId;
  }

  const member = {
    socket,
    roomId,
    clientId,
    nickname: String(url.searchParams.get('nickname') || 'Гость').slice(0, 80),
    avatarUrl: String(url.searchParams.get('avatarUrl') || '').slice(0, 500),
    role,
    canControl: role === 'host',
  };
  room.members.set(clientId, member);
  room.emptySince = 0;

  sendConnected(member, room);
  broadcastParticipants(room);
  console.log(`[комната] ${member.nickname} (${clientId}) вошёл как ${role} в ${roomId}. Сейчас людей: ${room.members.size}`);

  socket.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (text.length > 100_000) {
      send(member, 'ERROR', { message: 'Слишком длинное сообщение' });
      return;
    }
    onClientMessage(member, room, text);
  });

  socket.on('close', () => {
    if (room.members.get(clientId)?.socket !== socket) {
      return;
    }
    removeMember(room, clientId);
  });
}

function ensureHttpMember(body) {
  const roomId = String(body.roomId || '').trim();
  const clientId = String(body.clientId || '').trim();
  const roleHint = body.roleHint === 'host' || body.role === 'host' ? 'host' : 'listener';
  if (!roomId || !clientId) {
    return { error: 'Нет номера комнаты' };
  }

  let room = rooms.get(roomId);
  const wantsHost = roleHint === 'host';
  if (!room) {
    if (!wantsHost) {
      return { error: 'Комната не найдена. Попроси ссылку у того, кто её создал.' };
    }
    room = {
      id: roomId,
      hostClientId: clientId,
      members: new Map(),
      track: null,
      playback: null,
      stateVersion: 0,
      updatedAt: Date.now(),
      emptySince: 0,
    };
    rooms.set(roomId, room);
  }

  const existing = room.members.get(clientId);
  if (existing && !existing.socket) {
    existing.lastSeen = Date.now();
    if (body.nickname) {
      existing.nickname = String(body.nickname).slice(0, 80);
    }
    return { room, member: existing };
  }

  if (existing && existing.socket) {
    try {
      existing.socket.close(4000, 'replaced');
    } catch (_error) {
      // Старый сокет уже закрыт.
    }
    room.members.delete(clientId);
  }

  const role = wantsHost && (room.members.size === 0 || room.hostClientId === clientId)
    ? 'host'
    : 'listener';
  if (role === 'host') {
    room.hostClientId = clientId;
  }

  const member = {
    socket: null,
    inbox: [],
    flush: null,
    roomId,
    clientId,
    nickname: String(body.nickname || 'Гость').slice(0, 80),
    avatarUrl: String(body.avatarUrl || '').slice(0, 500),
    role,
    canControl: role === 'host',
    lastSeen: Date.now(),
  };
  room.members.set(clientId, member);
  room.emptySince = 0;
  sendConnected(member, room);
  broadcastParticipants(room);
  console.log(`[комната] ${member.nickname} (${clientId}) вошёл как ${role} в ${roomId}. Сейчас людей: ${room.members.size}`);
  return { room, member };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handlePoll(body, res) {
  const joined = ensureHttpMember(body);
  if (joined.error) {
    writeJson(res, 200, {
      events: [{
        type: 'ERROR',
        roomId: body.roomId || '',
        ts: Date.now(),
        v: PROTOCOL_VERSION,
        payload: { message: joined.error },
      }],
    });
    return;
  }

  const { room, member } = joined;
  const pollId = (member.pollGeneration = (member.pollGeneration || 0) + 1);
  if (typeof member.flush === 'function') {
    const previous = member.flush;
    member.flush = null;
    previous();
  }
  if (body.bye) {
    removeMember(room, member.clientId);
    writeJson(res, 200, { events: [] });
    return;
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  for (const message of incoming) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    if (text.length > 100_000) {
      send(member, 'ERROR', { message: 'Слишком длинное сообщение' });
      continue;
    }
    onClientMessage(member, room, text);
  }

  if (!member.inbox.length) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        member.flush = null;
        resolve();
      }, 8000);
      member.flush = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  if (member.pollGeneration !== pollId) {
    return;
  }
  const events = member.inbox.splice(0);
  writeJson(res, 200, { events });
}

function sweepEmptyRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.members.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(room.id);
    }
  }
}

const server = http.createServer((req, res) => {
  console.log(`[http] ${req.method} ${req.url}`);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/api/poll') {
    readRequestBody(req)
      .then((body) => handlePoll(body, res))
      .catch(() => {
        writeJson(res, 400, { events: [] });
      });
    return;
  }
  if (url.pathname === '/api' || url.pathname === '/api/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>Синхронизация музыки</title><p>Сервер комнаты запущен. Это окно можно закрыть.</p>');
});

const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', attachClient);

setInterval(sweepEmptyRooms, 10_000);

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят. Старый сервер ещё запущен, второй запускать не нужно.`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер комнаты слушает порт ${PORT}`);
  console.log(`Проверка в браузере: http://127.0.0.1:${PORT}/api`);
  console.log(`Для этого компьютера расширение уже смотрит на ws://127.0.0.1:${PORT}/api/ws`);
  for (const address of lanAddresses()) {
    console.log(`Для другого компьютера в этой же сети: ws://${address}:${PORT}/api/ws`);
  }
});
