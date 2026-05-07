const User = require("../models/User");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────
// Socket Service — Real-time synchronization
// ─────────────────────────────────────────────────────────────

let _io = null;

/**
 * Initialize the Socket.io Server instance.
 * Call this exactly once from server.js.
 */
const init = (io) => {
  if (_io) {
    logger.warn("⚠️ Socket.io is already initialized.");
    return;
  }
  _io = io;

  // ── JWT Auth Middleware ─────────────────────────────────────
  // Verify token on handshake; attach userId to socket.
  // Allows unauthenticated connections for public slot viewing.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      // Allow connection but mark as unauthenticated
      socket.userId = null;
      return next();
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: "hackhive-scheduler",
        audience: "hackhive-client",
        algorithms: ["HS256"],
      });
      socket.userId = decoded.id;
      next();
    } catch {
      // Allow connection but mark as unauthenticated
      socket.userId = null;
      next();
    }
  });

  io.on("connection", (socket) => {
    logger.info(`⚡ Client connected: ${socket.id}${socket.userId ? ` (user: ${socket.userId})` : " (anonymous)"}`);

    // Auto-join personal notification room if authenticated
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    // ── Authentication / Dashboard Sync ───────────────────────
    
    // Legacy fallback: allow re-authentication via event
    socket.on("auth:authenticate", (userId) => {
      if (!userId) return;
      
      if (socket.userId && socket.userId !== userId) {
        socket.leave(`user:${socket.userId}`);
      }
      
      socket.join(`user:${userId}`);
      socket.userId = userId;
    });

    // ── Public Slot Synchronization ───────────────────────────
    
    socket.on("host:subscribe_slots", (hostId) => {
      if (!hostId) return;
      socket.join(`host_slots:${hostId}`);
    });

    socket.on("host:unsubscribe_slots", (hostId) => {
      socket.leave(`host_slots:${hostId}`);
    });

    // ── Real-time Slot Locking (optimistic UI) ────────────────
    
    socket.on("slot:lock", ({ slotId, hostId }) => {
      socket.to(`host_slots:${hostId}`).emit("slot:locked", { slotId });
    });

    socket.on("slot:unlock", ({ slotId, hostId }) => {
      socket.to(`host_slots:${hostId}`).emit("slot:unlocked", { slotId });
    });

    // ── Active Meeting Rooms (WebRTC / Chat) ──────────────────
    
    socket.on("meeting:join", (meetingId) => {
      if (!meetingId) return;
      socket.join(`meeting:${meetingId}`);
      socket.to(`meeting:${meetingId}`).emit("meeting:user_joined", {
        userId: socket.userId,
        socketId: socket.id,
      });
    });

    socket.on("meeting:leave", (meetingId) => {
      socket.leave(`meeting:${meetingId}`);
      socket.to(`meeting:${meetingId}`).emit("meeting:user_left", {
        userId: socket.userId,
        socketId: socket.id,
      });
    });

    socket.on("meeting:signal", ({ to, signal }) => {
      io.to(to).emit("meeting:signal", { from: socket.id, signal });
    });

    socket.on("meeting:chat", ({ meetingId, message }) => {
      io.to(`meeting:${meetingId}`).emit("meeting:chat", {
        userId: socket.userId,
        message,
        timestamp: new Date(),
      });
    });

    socket.on("meeting:typing", ({ meetingId }) => {
      socket.to(`meeting:${meetingId}`).emit("meeting:typing", { userId: socket.userId });
    });

    // ── Disconnect ────────────────────────────────────────────
    socket.on("disconnect", () => {
      logger.info(`🔌 Client disconnected: ${socket.id}`);
    });
  });
};

const getIO = () => {
  if (!_io) throw new Error("Socket service not initialized — call init(io) first.");
  return _io;
};

// ─────────────────────────────────────────────────────────────
// Emission Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Notify a specific user directly (e.g. they got booked).
 * Also persists the notification to MongoDB.
 *
 * Uses atomic $push to avoid race conditions when multiple
 * notifications fire simultaneously for the same user, and to
 * bypass full-document validation that could silently drop writes.
 */
const notifyUser = async (userId, notification) => {
  const notifDoc = {
    message: notification.message,
    type: notification.type || "system",
    relatedMeeting: notification.relatedMeeting || null,
    read: false,
    createdAt: new Date(),
  };

  try {
    const result = await User.updateOne(
      { _id: userId },
      { $push: { notifications: notifDoc } }
    );
    if (result.matchedCount === 0) {
      logger.warn(`⚠️ notifyUser: user ${userId} not found — notification dropped`);
    }
  } catch (err) {
    logger.error(`❌ Failed to persist notification for user ${userId}: ${err.message}`);
  }

  // Emit in real-time if they are online
  try {
    getIO().to(`user:${userId}`).emit("notification", notifDoc);
  } catch (err) {
    logger.warn(`⚠️ Failed to emit real-time notification for user ${userId}: ${err.message}`);
  }
};

/**
 * Broadcast slot changes to anyone viewing a specific host's booking page.
 * Action: 'created', 'updated', 'deleted', 'booked'
 */
const emitSlotUpdate = (hostId, action, payload) => {
  getIO().to(`host_slots:${hostId}`).emit(`slot:${action}`, payload);
};

/**
 * Emit an event that tells the user's dashboard to refresh its data.
 * Used when meetings are created, cancelled, or rescheduled.
 */
const emitDashboardUpdate = (userId, type) => {
  getIO().to(`user:${userId}`).emit("dashboard:update", { type });
};

module.exports = {
  init,
  getIO,
  notifyUser,
  emitSlotUpdate,
  emitDashboardUpdate,
};
