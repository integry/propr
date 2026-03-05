import { Server as SocketIOServer } from 'socket.io';
import { Queue, QueueEvents } from 'bullmq';
import {
  QUEUE_STATS_UPDATE,
  type QueueStatsUpdatePayload,
  type QueueStatsData
} from '@propr/shared';

/**
 * QueueBroadcaster manages BullMQ event listeners and queue stats broadcasting.
 * It handles real-time queue statistics updates via WebSocket.
 */
export class QueueBroadcaster {
  private queueEvents: QueueEvents | null = null;
  private queueStatsInterval: ReturnType<typeof setInterval> | null = null;
  private io: SocketIOServer;
  private queue: Queue;

  constructor(io: SocketIOServer, queue: Queue) {
    this.io = io;
    this.queue = queue;
  }

  /**
   * Initialize BullMQ event listeners and start periodic broadcasting
   */
  init(): void {
    this.setupQueueEventListeners();
    this.startQueueStatsBroadcast();
    console.log('[QueueBroadcaster] Initialized');
  }

  /**
   * Set up BullMQ event listeners for real-time queue updates
   */
  private setupQueueEventListeners(): void {
    this.queueEvents = new QueueEvents(this.queue.name, {
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      }
    });

    // Broadcast queue stats on significant events
    this.queueEvents.on('completed', async () => {
      await this.broadcastQueueStats();
    });

    this.queueEvents.on('failed', async () => {
      await this.broadcastQueueStats();
    });

    this.queueEvents.on('active', async () => {
      await this.broadcastQueueStats();
    });

    this.queueEvents.on('waiting', async () => {
      await this.broadcastQueueStats();
    });

    this.queueEvents.on('delayed', async () => {
      await this.broadcastQueueStats();
    });

    console.log('[QueueBroadcaster] BullMQ event listeners initialized');
  }

  /**
   * Start periodic queue stats broadcasting
   */
  private startQueueStatsBroadcast(): void {
    // Broadcast queue stats every 5 seconds to ensure UI stays updated
    this.queueStatsInterval = setInterval(async () => {
      const room = this.io.sockets.adapter.rooms.get('queue:stats');
      if (room && room.size > 0) {
        await this.broadcastQueueStats();
      }
    }, 5000);

    console.log('[QueueBroadcaster] Queue stats periodic broadcast started');
  }

  /**
   * Broadcast current queue statistics to subscribed clients
   */
  async broadcastQueueStats(): Promise<void> {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.queue.getWaitingCount(),
        this.queue.getActiveCount(),
        this.queue.getCompletedCount(),
        this.queue.getFailedCount(),
        this.queue.getDelayedCount()
      ]);

      const stats: QueueStatsData = {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed
      };

      const payload: QueueStatsUpdatePayload = {
        eventType: QUEUE_STATS_UPDATE,
        stats,
        timestamp: new Date().toISOString()
      };

      this.io.to('queue:stats').emit(QUEUE_STATS_UPDATE, payload);
    } catch (error) {
      console.error('[QueueBroadcaster] Failed to broadcast queue stats:', error);
    }
  }

  /**
   * Clean up resources
   */
  async close(): Promise<void> {
    if (this.queueStatsInterval) {
      clearInterval(this.queueStatsInterval);
      this.queueStatsInterval = null;
    }

    if (this.queueEvents) {
      await this.queueEvents.close();
      this.queueEvents = null;
    }

    console.log('[QueueBroadcaster] Closed');
  }
}
