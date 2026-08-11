import { io } from 'socket.io-client';
import { getAccessToken } from './api';

const socketUrl = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000';

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io(socketUrl, {
      autoConnect: false,
      auth: (cb) => cb({ token: getAccessToken() }),
    });
  }
  return socket;
}

export function connectSocket() {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}

export function disconnectSocket() {
  socket?.disconnect();
}

export function joinWoning(woningId) {
  return new Promise((resolve, reject) => {
    connectSocket().emit('join-woning', woningId, (ack) => {
      if (ack?.ok) resolve();
      else reject(new Error(ack?.error || 'join failed'));
    });
  });
}

export function leaveWoning(woningId) {
  getSocket().emit('leave-woning', woningId);
}
