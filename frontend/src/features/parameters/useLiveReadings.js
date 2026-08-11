import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { connectSocket, getSocket, joinWoning, leaveWoning } from '../../services/socket';
import { liveReadingReceived } from './parametersSlice';

// Accepts either a single woningId or an array of them (e.g. the "alle
// installaties" overview, which needs live readings from every woning at once).
export function useLiveReadings(woningIdOrIds) {
  const dispatch = useDispatch();
  const ids = (Array.isArray(woningIdOrIds) ? woningIdOrIds : [woningIdOrIds]).filter(Boolean);
  const key = ids.slice().sort().join(',');

  useEffect(() => {
    if (ids.length === 0) return undefined;

    connectSocket();
    const joinedIds = [];
    ids.forEach((id) => {
      joinWoning(id)
        .then(() => joinedIds.push(id))
        .catch((err) => console.error('Kon woning-kanaal niet joinen', err));
    });

    const socket = getSocket();
    const handler = (reading) => dispatch(liveReadingReceived(reading));
    socket.on('reading', handler);

    return () => {
      socket.off('reading', handler);
      joinedIds.forEach((id) => leaveWoning(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dispatch]);
}
