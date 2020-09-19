import { promises as fs } from 'fs';
import { FileHandle } from 'fs/promises';
import { decompressSector } from './compression';
import { MpqFlags, MpqFormatVersion, MpqHashType } from './const';
import {
  MpqBlockEntry,
  MpqBlockTableEntry,
  MpqHashEntry,
  MpqHashTableEntry,
  MpqHeader,
  MpqHeaderReader,
} from './header';
import { MpqEncryptionTable } from './encryption';

// Common big ints used during decompression
const x0b = BigInt(0x0b);
const x11111111 = BigInt(0x11111111);
const x15 = BigInt(0x15);
const x3 = BigInt(0x3);
const x400 = BigInt(0x400);
const x5 = BigInt(0x5);
const xff = BigInt(0xff);
const xffffffff = BigInt(0xffffffff);

const charA = 'a'.charCodeAt(0);
const charZ = 'z'.charCodeAt(0);

const upperCaseChange = charA - 'A'.charCodeAt(0);

export abstract class Mpq {
  hashTable: Map<string, MpqHashEntry>;
  blockTable: MpqBlockEntry[];

  /** Create a new instance of a MPQ Reader */
  static load(file: Buffer | string): Mpq {
    if (typeof file == 'string') return new MpqFile(file);
    return new MpqBuffer(file);
  }

  abstract read(offset: number, byteCount: number): Promise<Buffer>;

  private async readHeader(): Promise<MpqHeader> {
    const headerBuf = await this.read(0, 32);
    const header = MpqHeaderReader.raw(headerBuf);

    if (header.magic != 'MPQ\x1a') throw new Error('Only MPQ.magic 0x1a is supported');
    if (header.formatVersion !== MpqFormatVersion.Version1) throw new Error('Only MPQ.format 0x00 is supported');

    const hashTableSize = header.hashTableEntries * 16;
    const hashTableBuf = await this.read(header.hashTableOffset, hashTableSize);
    this.decrypt(hashTableBuf, this.hash(`(hash table)`, MpqHashType.Table));

    const blockTableSize = header.blockTableEntries * 16;
    const blockTableBuf = await this.read(header.blockTableOffset, blockTableSize);
    this.decrypt(blockTableBuf, this.hash(`(block table)`, MpqHashType.Table));

    const ctx = { offset: 0, startOffset: 0 };
    const blockTable: MpqBlockEntry[] = [];
    for (let i = 0; i < header.blockTableEntries; i++) blockTable.push(MpqBlockTableEntry.parse(blockTableBuf, ctx));
    this.blockTable = blockTable;

    ctx.offset = 0;
    ctx.startOffset = 0;
    const hashTable: Map<string, MpqHashEntry> = new Map();
    for (let i = 0; i < header.hashTableEntries; i++) {
      const entry = MpqHashTableEntry.parse(hashTableBuf, ctx);
      const hashKey = `${entry.hashB}.${entry.hashA}`;
      hashTable.set(hashKey, entry);
    }
    this.hashTable = hashTable;
    return header;
  }

  _header: Promise<MpqHeader> | null;
  get header(): Promise<MpqHeader> {
    if (this._header == null) {
      this._header = this.readHeader();
    }
    return this._header;
  }

  private async getFileEntry(fileName: string): Promise<MpqHashEntry | undefined> {
    await this.header;
    const hashA = this.hash(fileName, MpqHashType.HashA);
    const hashB = this.hash(fileName, MpqHashType.HashB);
    const hashKey = `${hashB}.${hashA}`;
    return this.hashTable.get(hashKey);
  }

  /**
   * Does a file exist inside the MPQ
   * @param fileName file tlookup
   */
  async exists(fileName: string): Promise<boolean> {
    return this.getFileEntry(fileName) != null;
  }

  /**
   * Extract a file from the MPQ
   * @param fileName file to extract
   * @returns File buffer if it exists null other wise
   */
  async extract(fileName: string): Promise<Buffer | null> {
    const header = await this.header;
    const hashEntry = await this.getFileEntry(fileName);
    if (hashEntry == null) return null;

    const blockEntry = this.blockTable[hashEntry.blockTableIndex];
    if ((blockEntry.flags & MpqFlags.Exists) == 0) return null;
    // Empty File
    if (blockEntry.archivedSize == 0) return Buffer.alloc(0);

    // TODO Should really handle these flags
    if (blockEntry.flags & MpqFlags.Encrypted) throw new Error('MPQ flag:Encrypted not supported');
    if (blockEntry.flags & MpqFlags.SingleUnit) throw new Error('MPQ flag:SingleUnit not supported');
    if (blockEntry.flags & MpqFlags.Crc) throw new Error('MPQ flag:Crc not supported');

    // const isCompressed = (blockEntry.flags & MpqFlags.Compressed) == MpqFlags.Compressed;
    // const isImplode = (blockEntry.flags & MpqFlags.Implode) == MpqFlags.Implode;
    // const isCrcEmbedded = (blockEntry.flags & MpqFlags.Crc) == MpqFlags.Crc;

    const sectorSize = 512 << header.sectorSizeShift;
    const sectors = Math.ceil(blockEntry.size / sectorSize);

    const fileData = await this.read(blockEntry.offset, blockEntry.archivedSize);

    const sectorIndexes = [];
    let offset = 0;
    let lastIndex = 0;
    for (let i = 0; i < sectors + 1; i++) {
      const sectorIndex = fileData.readUInt32LE(offset);
      if (sectorIndex < lastIndex) throw new Error('Failed to read MPQ invalid sectors detected');
      const currentSectorSize = sectorIndex - lastIndex;
      if (currentSectorSize > sectorSize) throw new Error('Failed to read MPQ invalid sectors detected');

      if (offset > blockEntry.archivedSize) throw new Error('Failed to read MPQ invalid sector overflow');
      lastIndex = sectorIndex;
      offset += 4;
      sectorIndexes.push(sectorIndex);
    }

    const outputBuffer = Buffer.alloc(blockEntry.size);
    for (let i = 0; i < sectorIndexes.length - 1; i++) {
      const readOffset = sectorIndexes[i];
      const readBytes = sectorIndexes[i + 1] - readOffset;

      // If the sector is not compressed just copy it
      if (readBytes == sectorSize) {
        fileData.copy(outputBuffer, i * sectorSize, readOffset, readOffset + sectorSize);
        continue;
      }

      const decompressedBytes = await decompressSector(fileData, readOffset, readBytes);
      decompressedBytes.copy(outputBuffer, i * sectorSize, 0, decompressedBytes.length);
    }

    return outputBuffer;
  }

  /**
   * Create a MPQ hash of a string using the given mpq hash type
   * @param str String to hash
   * @param type MPQ hash type to use
   */
  hash(str: string, type: MpqHashType): number {
    let seed1 = BigInt(0x7fed7fed);
    let seed2 = BigInt(0xeeeeeeee);
    for (let i = 0; i < str.length; i++) {
      let ch = str.charCodeAt(i);
      // upper case lowercase characters
      if (ch >= charA && ch < charZ) ch -= upperCaseChange;
      const value = MpqEncryptionTable.get((type << 8) + ch);
      if (value == null) throw new Error('MPQ Unable to hash character: ' + ch);
      seed1 = (value ^ (seed1 + seed2)) & xffffffff;
      seed2 = (BigInt(ch) + seed1 + seed2 + (seed2 << x5) + x3) & xffffffff;
    }
    return Number(seed1);
  }

  /**
   * Decrypt MPQ data
   * @param data buffer of data needing to be decrypted
   * @param key key to use to decrypt the buffer
   */
  decrypt(data: Buffer, key: number): void {
    let seed1 = BigInt(key);
    let seed2 = BigInt(0xeeeeeeee);

    const itLen = Math.floor(data.length / 4);
    for (let i = 0; i < itLen; i++) {
      const encValue = MpqEncryptionTable.get(Number(x400 + (seed1 & xff)));
      if (encValue == null) throw new Error('MPQ Unable to decrypt char: ' + Number(x400 + (seed1 & xff)));
      seed2 += encValue;
      seed2 &= xffffffff;

      let bufValue = BigInt(data.readUInt32LE(i * 4));
      bufValue = (bufValue ^ (seed1 + seed2)) & xffffffff;

      seed1 = ((~seed1 << x15) + x11111111) | (seed1 >> x0b);
      seed1 &= xffffffff;

      seed2 = (bufValue + seed2 + (seed2 << x5) + x3) & xffffffff;
      data.writeUInt32LE(Number(bufValue), i * 4);
    }
  }
}

/**
 * MPQ loaded from a file
 * Reading only the bytes needed to process the mpq
 * Good for large MPQ files
 */
export class MpqFile extends Mpq {
  fileName: string;
  constructor(fileName: string) {
    super();
    this.fileName = fileName;
  }

  _fd: Promise<FileHandle>;
  get fd(): Promise<FileHandle> {
    if (this._fd == null) {
      this._fd = fs.open(this.fileName, 'r');
    }
    return this._fd;
  }

  async read(offset: number, byteCount: number): Promise<Buffer> {
    const outputBuf = Buffer.allocUnsafe(byteCount);
    const fd = await this.fd;
    await fd.read(outputBuf, 0, byteCount, offset);
    return outputBuf;
  }
}

/**
 * MPQ reader from memory
 * Fast for small MPQ Files and for files that are already in memory
 */
export class MpqBuffer extends Mpq {
  buffer: Buffer;
  constructor(buffer: Buffer) {
    super();
    this.buffer = buffer;
  }

  async read(offset: number, byteCount: number): Promise<Buffer> {
    return this.buffer.slice(offset, offset + byteCount);
  }
}
