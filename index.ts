import { Server, RtcioEvents } from "rtc.io-server";

const server = new Server({
  cors: {
    origin: "*",
  },
});

const localPort = process.env.PORT ? parseInt(process.env.PORT) : 3001;
server.listen(localPort);

const lastMediaState = new Map<string, { mic: boolean; cam: boolean }>();

// Per-room password registry. The first joiner that supplies a non-empty
// password owns the room; later joiners must present the same password.
// Entries are evicted when the room empties, so any room name is reusable
// after everyone leaves and there's no persistent state to manage.
const roomPasswords = new Map<string, string>();

function trimPassword(p: unknown): string {
  return typeof p === "string" ? p.trim() : "";
}

server.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("stopScreenShare", (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit("stopScreenShare", data);
    }
  });


  socket.on("check-room", (payload: { roomId?: string; password?: string }) => {
    const roomId = payload?.roomId;
    if (!roomId || typeof roomId !== "string") {
      socket.emit("join-error", { reason: "invalid-room", roomId });
      return;
    }
    const supplied = trimPassword(payload?.password);
    const occupants = server.sockets.adapter.rooms.get(roomId);
    const hasOccupants = !!(occupants && occupants.size > 0);
    const stored = roomPasswords.get(roomId) ?? "";
    if (hasOccupants && stored && supplied !== stored) {
      socket.emit("join-error", {
        reason: supplied ? "wrong-password" : "password-required",
        roomId,
      });
      return;
    }

    socket.emit("room-check-ok", {
      roomId,
      passwordRequired: hasOccupants && !!stored,
    });
  });

  socket.on("join-room", (payload: { name: string; roomId: string; password?: string }) => {
    const { name, roomId } = payload ?? ({} as any);
    const supplied = trimPassword(payload?.password);
    if (!roomId || typeof roomId !== "string") {
      socket.emit("join-error", { reason: "invalid-room", roomId });
      return;
    }
    console.log("join-room", name, roomId, supplied ? "(with password)" : "");

    const existing = server.sockets.adapter.rooms.get(roomId);
    const hasOccupants = !!(existing && existing.size > 0);
    const stored = roomPasswords.get(roomId) ?? "";

    if (hasOccupants) {
      // Existing room: caller must match whatever password (if any) was set
      // when the room was first occupied.
      if (stored && supplied !== stored) {
        socket.emit("join-error", {
          reason: stored ? "wrong-password" : "password-required",
          roomId,
        });
        return;
      }
    } else {
      // Empty room: this caller seeds the password for the room's lifetime.
      // Empty string means "open room", same as before.
      if (supplied) roomPasswords.set(roomId, supplied);
      else roomPasswords.delete(roomId);
    }

    socket.data.name = name;
    socket.data.roomId = roomId;

    const existingUsers = Array.from(existing || []);
    socket.join(roomId);

    existingUsers.forEach((id) => {
      const existingSocket = server.sockets.sockets.get(id);
      if (!existingSocket) {
        console.log("existingSocket not found", id);
        return;
      }
      socket.emit("user-connected", { name: existingSocket.data.name, id });
      const state = lastMediaState.get(id);
      if (state) {
        socket.emit("media-state", {
          id,
          roomId,
          mic: state.mic,
          cam: state.cam,
        });
      }
    });

    socket.emit("join-ok", { roomId });
    socket.to(roomId).emit("user-connected", { name, id: socket.id });
    socket.to(roomId).emit(RtcioEvents.INIT_OFFER, { source: socket.id });
  });

  socket.on("chat-message", (message) => {
    console.log("chat-message", message);
    socket.to(message.roomId).emit("chat-message", message);
  });

  socket.on("media-state", (data) => {
    if (!data?.roomId) return;
    if (typeof data.mic === "boolean" && typeof data.cam === "boolean") {
      lastMediaState.set(socket.id, { mic: data.mic, cam: data.cam });
    }
    socket.to(data.roomId).emit("media-state", data);
  });

  socket.on("disconnecting", () => {
    console.log("disconnecting", socket.id);
    lastMediaState.delete(socket.id);
    socket.rooms.forEach((roomId) => {
      if (roomId === socket.id) return;
      socket.to(roomId).emit("user-disconnected", { id: socket.id });

      // Last person out turns off the lights — drop the password so the room
      // name is reusable. socket.io evicts `socket` from `roomId` *after*
      // this hook runs, so size 1 means we're the only occupant.
      const occupants = server.sockets.adapter.rooms.get(roomId);
      if (occupants && occupants.size <= 1) {
        roomPasswords.delete(roomId);
      }
    });
  });
});
