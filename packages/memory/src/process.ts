import { toHex } from '@diablo2/data';
import { promises as fs } from 'fs';
import { FileHandle } from 'fs/promises';
import { MemoizeExpiring } from 'typescript-memoize';
import {ScannerBuffer} from "./scanner.js";

export interface ProcessMemoryMap {
  start: number;
  end: number;
  permissions: string;
  path?: string;
  line: string;
}

export type FilterFunc = (f: ProcessMemoryMap) => boolean;

export class Process {
  pid: number;
  fh: Promise<FileHandle> | null;

  constructor(pid: number) {
    this.pid = pid;
  }

  /** Find a pid from a process name */
  static async findPidByName(name: string): Promise<number | null> {
    const files = await fs.readdir('/proc');
    for (const file of files) {
      const pid = Number(file);
      if (isNaN(pid)) continue;

      try {
        const data = await fs.readFile(`/proc/${file}/status`);
        const first = data.toString().split('\n')[0];
        const fileName = first.split('\t')[1];
        if (fileName.includes(name)) return pid;
      } catch (e) {
        // noop
      }
    }
    return null;
  }

  /** Load the memory map */
  @MemoizeExpiring(10_000)
  async loadMap(): Promise<ProcessMemoryMap[]> {
    const data = await fs.readFile(`/proc/${this.pid}/maps`);

    const memLines = data.toString().trim().split('\n');

    const memMaps: ProcessMemoryMap[] = [];
    for (const line of memLines) {
      const parts = line.split(' ');
      const [start, end] = parts[0].split('-').map((c) => parseInt(c, 16));

      const obj = {
        start,
        end,
        permissions: parts[1],
        path: parts.length > 7 ? parts[parts.length - 1] : undefined,
        line,
      };

      // If the process cant write to it, then its not useful to us
      if (!obj.permissions.startsWith('rw')) continue;
      // Ignore graphic card data
      if (obj.path?.includes('/dev/nvidia')) continue;

      memMaps.push(obj);
    }

    return memMaps;
  }

  /** Read a section of memory from this process */
  async read(offset: number, count: number): Promise<Buffer> {
    try {
      if (this.fh == null) this.fh = fs.open(`/proc/${this.pid}/mem`, 'r');
      const fh = await this.fh;
      const buf = Buffer.alloc(count);

      const ret = await fh?.read(buf, 0, buf.length, offset);
      if (ret == null || ret.bytesRead === 0) throw new Error('Failed to read memory at: ' + toHex(offset));

      return buf;
    } catch (e) {
      // console.trace(`Failed to read, ${offset}, ${count}`);
      throw new Error('Failed to read memory at: ' + toHex(offset) + ' - ' + e);
    }
  }

  async isValidMemoryMap(offset: number): Promise<boolean> {
    const maps = await this.loadMap();

    for (const map of maps) {
      if (map.start < offset && map.end > offset) return true;
    }
    return false;
  }

  async *scan(f?: FilterFunc): AsyncGenerator<{ buffer: Buffer; offset: number; map: ProcessMemoryMap }> {
    const maps = await this.loadMap();

    for (const map of maps) {
      if (f != null && f(map) === false) continue;

      try {
        const buffer = await this.read(map.start, map.end - map.start);
        yield { buffer, offset: map.start, map: map };
      } catch (err) {
        // console.trace({ err }, 'Scan:Failed');
        break;
      }
    }
  }

  /** Scan memory near a point */
  async *scanDistance(
    offset: number,
    f?: FilterFunc,
  ): AsyncGenerator<{ buffer: Buffer; offset: number; map: ProcessMemoryMap }> {
    const maps = await this.loadMap();
    maps.sort((a, b) => {
      const aStart = Math.abs(a.start - offset);
      const bStart = Math.abs(b.start - offset);
      return aStart - bStart;
    });

    for (const map of maps) {
      // const buffer = await this.read(map.start, map.end - map.start);
      // let xx11 = ScannerBuffer.text(buffer, 'Ishani', 16)
      // let xx11val = xx11.next().value;
      // if(xx11val > 0) {
      //   console.log("####", map.line, xx11val);
      //
      //   try {
      //     const buffer = await this.read(map.start, map.end - map.start);
      //     yield { buffer, offset: map.start, map: map };
      //   } catch (err) {
      //     // console.trace({ err, offset }, 'Scan:Distance');
      //     break;
      //   }
      // }

      if (f != null && f(map) === false) continue;

      try {
        const buffer = await this.read(map.start, map.end - map.start);
        yield { buffer, offset: map.start, map: map };
      } catch (err) {
        // console.trace({ err, offset }, 'Scan:Distance');
        break;
      }
    }
  }

  /** Scan memory backwards */
  async *scanReverse(f?: FilterFunc): AsyncGenerator<{ buffer: Buffer; offset: number; map: ProcessMemoryMap }> {
    const maps = await this.loadMap();

    for (const map of maps.reverse()) {
      if (f != null && f(map) === false) continue;
      try {
        const buffer = await this.read(map.start, map.end - map.start);
        yield { buffer, offset: map.start, map: map };
      } catch (err) {
        // console.trace({ err }, 'Scan:Reverse');
        break;
      }
    }
  }
}
