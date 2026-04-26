import { Server, RtcioEvents } from "rtc.io-server";

const server = new Server({
  cors: {
    origin: "*",
  },
});

const localPort = process.env.PORT ? parseInt(process.env.PORT) : 3001;
server.listen(localPort);

server.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("stopScreenShare", (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit("stopScreenShare", data);
    }
  });

  socket.on("join-room", ({ name, roomId }) => {
    console.log("join-room", name, roomId);
    socket.data.name = name;
    const existingUsers = Array.from(
      server.sockets.adapter.rooms.get(roomId) || []
    );
    socket.join(roomId);

    existingUsers.forEach((id) => {
      const existingSocket = server.sockets.sockets.get(id);
      if (!existingSocket) {
        console.log("existingSocket not found", id);
        return;
      }
      socket.emit("user-connected", { name: existingSocket.data.name, id });
    });

    socket.to(roomId).emit("user-connected", { name, id: socket.id });
    socket.to(roomId).emit(RtcioEvents.INIT_OFFER, { source: socket.id });
  });

  socket.on("chat-message", (message) => {
    console.log("chat-message", message);
    socket.to(message.roomId).emit("chat-message", message);
  });

  socket.on("disconnecting", () => {
    console.log("disconnecting", socket.id);
    socket.rooms.forEach((roomId) => {
      if (roomId === socket.id) return;
      socket.to(roomId).emit("user-disconnected", { id: socket.id });
    });
  });
});