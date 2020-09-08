import { Logger, Diablo2MpqLoader } from '@diablo2/bintools';
import { Diablo2Mpq, Diablo2MpqData } from '@diablo2/data';
import { Diablo2PacketFactory, PacketsPod } from '@diablo2/packets';
import { Diablo2GameSession } from './game.state';

export class Diablo2Client {
  mpq: Diablo2MpqData = Diablo2Mpq;
  clientToServer = new Diablo2PacketFactory('ClientServer');
  serverToClient = new Diablo2PacketFactory('ServerClient');

  constructor() {
    for (const packet of Object.values(PacketsPod.client)) this.clientToServer.register(packet);
    for (const packet of Object.values(PacketsPod.server)) this.serverToClient.register(packet);
  }

  async init(path: string, logger: Logger, mpq = Diablo2Mpq): Promise<void> {
    logger.info({ path }, 'Reading game data');
    this.mpq = mpq;
    await Diablo2MpqLoader.load(path, logger, mpq);
  }

  startSession(log: Logger): Diablo2GameSession {
    return new Diablo2GameSession(this, log);
  }
}
