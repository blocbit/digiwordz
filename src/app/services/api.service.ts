import { StreamMemory, STREAM_MEMORIES_KEY, StreamMemories } from './../models/stream-memory';
import { CachedUser, UsersCache } from './../models/users-cache';
import { Inject, Injectable, Optional } from '@angular/core';
import { PORTAL } from '../tokens/portal.token';
import { SkynetClient, genKeyPairFromSeed, genKeyPairAndSeed, defaultSkynetPortalUrl } from 'skynet-js';
import { UserData, UserKeys, USER_DATA_KEY } from '../models/user-data';
import { BaseMemory, UserMemoriesEncrypted, UserMemory, USER_MEMORIES_KEY_PREFIX } from '../models/user-memory';
import { v4 as uuidv4 } from 'uuid';
import { UserPublicMemory, UsersPublicMemories, USER_PUBLIC_MEMORIES_KEY } from '../models/user-public-memories';
import { UserSharedMemory, UserSharedMemoryLink, USER_SHARED_MEMORIES_KEY } from '../models/user-shared-memories';
import { ConnectedUser, SKYBRAIN_ACCOUNT_PUBLIC_KEY, USER_CONNECTED_USERS_KEY } from '../models/user-connected-users';
import * as cryptoJS from 'crypto-js';
import { EncryptionType } from '../models/encryption';
import { CachedUsers, SKYBRAIN_SKYDB_CACHED_USERS_KEY } from '../models/users-cache';
import { Ng2ImgMaxService } from 'ng2-img-max';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private skydbTimeout = 60000;
  private registerUserSkydbTimeout = 7000;
  private skynetClient: SkynetClient;

  // Cache mechanism
  private cachedUsersLocalStorageKey = "usersCache";
  private chacheTimeout: NodeJS.Timeout = setTimeout(() => { }, 0);

  // TODO: create a backend for that!
  private publicSkybrainSkyDBKey = "10acb3fa1047c27b28281f0ff9e870f53bd6911f9a7dd87e95472fa1c2d1ee4b9064afe68f239b52a5e5366f1eed2548b872bed361025699479890a54f9b26e1";

  constructor(
    @Optional() @Inject(PORTAL) private portal: string,
    @Inject(USER_DATA_KEY) private userDataKey: string,
    @Inject(USER_MEMORIES_KEY_PREFIX) private _userMemoriesSkydbKeyPrefix: string,
    @Inject(USER_PUBLIC_MEMORIES_KEY) private userPublicMemoriesSkydbKey: string,
    @Inject(USER_SHARED_MEMORIES_KEY) private userSharedMemoriesSkydbKey: string,
    @Inject(USER_CONNECTED_USERS_KEY) private userConnectedUsersSkydbKey: string,
    @Inject(SKYBRAIN_ACCOUNT_PUBLIC_KEY) private skyBrainAccountPublicKey: string,
    @Inject(SKYBRAIN_SKYDB_CACHED_USERS_KEY) private skyBrainSkyDBCachedUsersKey: string,
    @Inject(STREAM_MEMORIES_KEY) private streamMemoriesSkydbKey: string,
    private ng2ImgMax: Ng2ImgMaxService,
  ) {
    if (!portal) {
      this.portal = defaultSkynetPortalUrl;
    }
    this.skynetClient = new SkynetClient(this.portal);
  }

  private generateUserMemoriesKey(basePassphrase: string): string {
    const userMemoriesKeySuffix = cryptoJS.SHA256(`${basePassphrase}_USER_MEMORIES`).toString();
    return `${this._userMemoriesSkydbKeyPrefix}_${userMemoriesKeySuffix}`;
  }

  private generateUserMemoriesEncryptionKey(basePassphrase: string): string {
    const { privateKey } = genKeyPairFromSeed(`${basePassphrase}_USER_MEMORIES_ENCRYPTION`);
    return privateKey;
  }

  public generateUserKeys(passphrase: string): UserKeys {
    const { publicKey, privateKey } = genKeyPairFromSeed(passphrase);
    const memoriesEncryptionKey = this.generateUserMemoriesEncryptionKey(passphrase);
    const memoriesSkydbKey = this.generateUserMemoriesKey(passphrase);

    return { publicKey, privateKey, memoriesEncryptionKey, memoriesSkydbKey };
  }

  public async getBrainData({ publicKey }: Partial<UserKeys>): Promise<UserData> {
    if (!publicKey) {
      throw new Error('No publicKey');
    }

    try {
      const { data } = await this.skynetClient.db.getJSON(
        publicKey,
        this.userDataKey,
        {
          timeout: this.skydbTimeout,
        },
      ) || {};
      if (data) {
        const user = data as UserData;
        this.silentCacheUser({ toCacheUserPublicKey: publicKey, user });
        return user;
      }
    } catch (error) { }

    throw new Error('Could not get brain data');
  }

  private encryptUserMemories({ memories, memoriesEncryptionKey }: { memories: UserMemory[] } & Partial<UserKeys>): string {
    if (!memoriesEncryptionKey) {
      throw new Error('No memories encryption key');
    }

    return cryptoJS.AES.encrypt(
      JSON.stringify(memories),
      memoriesEncryptionKey
    ).toString();
  }

  public async updateUserData({ user, privateKey, revision }: { user?: UserData, revision?: number }
    & Partial<UserKeys>): Promise<UserData> {
    if (!privateKey) {
      throw new Error('No privateKey');
    }

    user = user || { nickname: '' };

    const publicKey = privateKey.slice(privateKey.length - 64);
    this.silentCacheUser({ toCacheUserPublicKey: publicKey, user });

    try {
      await this.skynetClient.db.setJSON(
        privateKey,
        this.userDataKey,
        user,
        revision,
        {
          timeout: this.skydbTimeout,
        },
      );
    } catch (error) {
      throw new Error('Could not update user data');
    }

    return user;
  }

  public async storeMemories({ memories, privateKey, memoriesSkydbKey, memoriesEncryptionKey, revision }:
    { memories: UserMemory[], revision?: number } & Partial<UserKeys>): Promise<void> {
    const encryptedMemories = this.encryptUserMemories({ memories, memoriesEncryptionKey });
    const encryptedMemoriesToStore: UserMemoriesEncrypted = {
      encryptedMemories,
      encryptionType: EncryptionType.KeyPairFromSeed
    };

    if (!memoriesSkydbKey) {
      throw new Error('No memories Skydb key');
    }

    if (!privateKey) {
      throw new Error('No privateKey');
    }

    try {
      await this.skynetClient.db.setJSON(
        privateKey,
        memoriesSkydbKey,
        encryptedMemoriesToStore,
        revision,
        {
          timeout: this.skydbTimeout,
        }
      );
    } catch (error) {
      throw new Error('Memories could not be saved');
    }
  }

  private async initUserData({ user, privateKey, memoriesSkydbKey, memoriesEncryptionKey }:
    { user?: UserData } & Partial<UserKeys>): Promise<UserData> {
    if (!privateKey) {
      throw new Error('No privateKey');
    }

    const initialRevision = 0;

    // genratate random username
    user = user || { nickname: `wordzmith-${Math.random().toString(36).substring(6)}` };

    // init connected users with the SkyBrain official publicKey
    const connectedUsers: ConnectedUser[] = [{
      publicKey: this.skyBrainAccountPublicKey,
      startedAt: new Date(Date.now()),
    }];

    try {
      await this.skynetClient.db.setJSON(
        privateKey,
        this.userPublicMemoriesSkydbKey,
        [] as UserPublicMemory[],
        initialRevision,
        {
          timeout: this.skydbTimeout,
        },
      );

      await this.skynetClient.db.setJSON(
        privateKey,
        this.userConnectedUsersSkydbKey,
        connectedUsers,
        initialRevision,
        {
          timeout: this.skydbTimeout,
        },
      );

      await this.skynetClient.db.setJSON(
        privateKey,
        this.userSharedMemoriesSkydbKey,
        [] as UserSharedMemory[],
        initialRevision,
        {
          timeout: this.skydbTimeout,
        },
      );
    } catch (error) {
      throw new Error('The user database could not be initialized');
    }

    await this.storeMemories({
      memories: [], privateKey, memoriesSkydbKey, memoriesEncryptionKey,
      revision: initialRevision
    });

    // This should be executed as the last one to ensure that all the other schemas are stored.
    await this.updateUserData({ user, privateKey, revision: initialRevision });

    return user;
  }

  public async registerUser({ ...keys }: Partial<UserKeys>): Promise<UserData> {
    if (!keys.publicKey) {
      throw new Error('No publicKey');
    }

    // Check if exists
    let userExists;
    try {
      userExists = await this.skynetClient.db.getJSON(
        keys.publicKey,
        this.userDataKey,
        {
          timeout: this.registerUserSkydbTimeout,
        },
      );
    } catch (error) { }

    if (userExists) {
      return userExists.data as UserData;
    }

    return await this.initUserData({ ...keys });
  }

  private decryptUserMemories({ encryptedMemories, memoriesEncryptionKey }:
    { encryptedMemories: string } & Partial<UserKeys>
  ): UserMemory[] {
    if (!memoriesEncryptionKey) {
      throw new Error('No memories encryption key');
    }

    const decryptedMemories = cryptoJS.AES.decrypt(
      encryptedMemories,
      memoriesEncryptionKey,
    ).toString(cryptoJS.enc.Utf8);
    const parsedDecrypted = JSON.parse(decryptedMemories);
    // tslint:disable-next-line: no-any
    return parsedDecrypted.map((m: any) => ({ ...m, added: new Date(m.added) }));
  }

  public async getMemories({ publicKey, memoriesSkydbKey, memoriesEncryptionKey }: Partial<UserKeys>): Promise<UserMemory[]> {
    if (!publicKey) {
      throw new Error('No publicKey');
    }

    if (!memoriesSkydbKey) {
      throw new Error('No memories Skydb key');
    }

    let response;

    try {
      response = await this.skynetClient.db.getJSON(
        publicKey,
        memoriesSkydbKey,
        {
          timeout: this.skydbTimeout,
        }
      );
    } catch (error) { }

    if (!response || !('data' in response)) {
      throw new Error(
        'Could not load memories',
      );
    }

    const storedEncryptedMemories = response.data as UserMemoriesEncrypted;
    const memories = this.decryptUserMemories({ encryptedMemories: storedEncryptedMemories.encryptedMemories, memoriesEncryptionKey });

    return memories;
  }

  public async addMemory({ memory, file, memories, privateKey, memoriesSkydbKey, memoriesEncryptionKey }:
    { memories: UserMemory[], memory: BaseMemory, file?: File } & Partial<UserKeys>
  ): Promise<UserMemory> {

    const newMemory = {
      id: uuidv4(),
      added: new Date(Date.now()),
      ...memory
    } as UserMemory;

    if (file && file instanceof File) {
      // TODO: use skystandards for data format
      if (file.type.indexOf('image') === 0) {
        this.resizeImage(file, 1200).then(async success => {
          newMemory.skylinkResized = await this.skynetClient.uploadFile(success);
        }, error => {
          console.log("Could not resize image: " + error)
        });
      }

      try {
        newMemory.skylink = await this.skynetClient.uploadFile(file);
        newMemory.mimeType = file.type;
      } catch (error) {
        throw new Error('The file could not be sent');
      }
    }

    memories.unshift(newMemory);

    try {
      await this.storeMemories({ memories, privateKey, memoriesSkydbKey, memoriesEncryptionKey });
    } catch (error) {
      throw new Error('Could not add new memory');
    }

    return newMemory;
  }

  private resizeImage(file: File, maxWidth: number): Promise<File> {
    return new Promise((resolve, reject) => {
      let image = new Image();
      image.src = URL.createObjectURL(file);
      image.onload = () => {
        if (image.width > 1280) {
          this.ng2ImgMax.resizeImage(file, maxWidth, 10000).subscribe(
            async result => {
              resolve(result);
            },
            error => {
              reject(error);
            }
          );
        } else {
          reject("image width less than 1200px")
        }
      };
      image.onerror = reject;
    });
  }

  public async getPublicMemories({ publicKey }: Partial<UserKeys>): Promise<UserPublicMemory[]> {
    let response;
    try {
      response = await this.skynetClient.db.getJSON(
        publicKey,
        this.userPublicMemoriesSkydbKey,
        {
          timeout: this.skydbTimeout,
        },
      );
    } catch (error) {
    }
    if (!response || !('data' in response)) {
      throw new Error(
        'Could not fetch public memories'
      );
    }

    const userPublicMemories = response.data as UserPublicMemory[];
    userPublicMemories.forEach(m => {
      m.memory.added = new Date(m.memory.added);
      m.memory.isPublic = true;
    });

    return userPublicMemories;
  }

  public async getPublicMemory({ id, publicKey }: { id: string } & Partial<UserKeys>): Promise<UserPublicMemory> {
    const publicMemories = await this.getPublicMemories({ publicKey });
    const found = publicMemories.find((m) => m.memory.id === id);
    if (found === undefined) {
      throw new Error(
        'Could not fetch public memory: not found!'
      );
    }

    return found;
  }

  private async deleteFromPublicMemories({ id, publicKey, privateKey }: { id: string } & Partial<UserKeys>): Promise<void> {
    let publicMemories = await this.getPublicMemories({ publicKey });
    const foundIndex = publicMemories.findIndex((pm) => pm.memory.id && pm.memory.id === id);
    if (foundIndex === -1) {
      return; // already deleted
    }

    if (foundIndex > -1) {
      publicMemories = [
        ...publicMemories.slice(0, foundIndex),
        ...publicMemories.slice(foundIndex + 1),
      ];

      try {
        await this.skynetClient.db.setJSON(
          privateKey,
          this.userPublicMemoriesSkydbKey,
          publicMemories,
          undefined,
          {
            timeout: this.skydbTimeout,
          },
        );
      } catch (error) {
        throw new Error('Could not remove memories from public domain');
      }
    }
  }

  private async deleteFromSharedMemories({ id, publicKey, privateKey }: { id: string } & Partial<UserKeys>): Promise<void> {
    const sharedMemories = await this.getSharedMemories({ publicKey });
    const filteredSharedMemories = sharedMemories.filter((m) => m.memoryId.search(id) === -1);

    if (filteredSharedMemories.length === sharedMemories.length) {
      return; // no elements to unshare
    }

    try {
      await this.skynetClient.db.setJSON(
        privateKey,
        this.userSharedMemoriesSkydbKey,
        filteredSharedMemories,
        undefined,
        {
          timeout: 10000,
        },
      );
    } catch (error) {
      throw new Error('Could not delete from shared memories');
    }
  }

  public async deleteMemory({ id, memories, publicKey, privateKey, memoriesSkydbKey, memoriesEncryptionKey }:
    { id: string, memories: UserMemory[] } & Partial<UserKeys>): Promise<void> {
    const foundIndex = memories.findIndex(memory => memory.id === id);
    if (foundIndex === -1) {
      throw new Error('Could not find memory to delete');
    }

    memories = [
      ...memories.slice(0, foundIndex),
      ...memories.slice(foundIndex + 1),
    ];

    try {
      await this.storeMemories({ memories, privateKey, memoriesSkydbKey, memoriesEncryptionKey });
    } catch (error) {
      throw new Error('Could not delete memory');
    }

    await this.deleteFromPublicMemories({ id, publicKey, privateKey });
    await this.deleteFromSharedMemories({ id, publicKey, privateKey });
  }

  public async publicMemory({ id, memories, privateKey, publicKey, memoriesSkydbKey, memoriesEncryptionKey }:
    { id: string, memories: UserMemory[] } & Partial<UserKeys>): Promise<void> {
    const found = memories.find((memory) => memory.id && memory.id === id);
    if (!found) {
      throw new Error('Could not find memory to make them public');
    }

    const publicMemories = await this.getPublicMemories({ publicKey });
    const foundIndex = publicMemories.findIndex((pm) => pm.memory.id && pm.memory.id === id);
    if (foundIndex > -1) {
      return;
    }

    found.isPublic = true;

    const tempFound = { ...found };
    /*
     It should be shared only with the person you want to share the memory and never saved in public memories
     because of the fact that user can decide to unpublic the memory without unshare.
    */
    delete tempFound.shareLink;

    const tempPublicMemory: UserPublicMemory = {
      publicAt: new Date(Date.now()),
      memory: tempFound,
    };

    publicMemories.unshift(tempPublicMemory);

    try {
      await this.skynetClient.db.setJSON(
        privateKey,
        this.userPublicMemoriesSkydbKey,
        publicMemories,
        undefined,
        {
          timeout: this.skydbTimeout,
        },
      );

    } catch (error) {
      throw new Error('Could not public memories');
    }

    this.storeMemories({ memories, privateKey, memoriesSkydbKey, memoriesEncryptionKey });
  }

  public async unpublicMemory({ id, memories, publicKey, privateKey, memoriesSkydbKey, memoriesEncryptionKey }:
    { id: string, memories: UserMemory[] } & Partial<UserKeys>): Promise<void> {
    await this.deleteFromPublicMemories({ id, publicKey, privateKey });

    const found = memories.find((memory) => memory.id && memory.id === id);
    if (found) {
      delete found.isPublic;
      this.storeMemories({ memories, privateKey, memoriesSkydbKey, memoriesEncryptionKey });
    }
  }

  public async getConnectedUsers({ publicKey }: Partial<UserKeys>): Promise<ConnectedUser[]> {
    let response;
    try {
      response = await this.skynetClient.db.getJSON(
        publicKey,
        this.userConnectedUsersSkydbKey,
        {
          timeout: this.skydbTimeout,
        },
      );
    } catch (error) {
    }

    if (!response || !('data' in response)) {
      throw new Error(
        'Could not fetch connected users',
      );
    }

    // tslint:disable-next-line: no-any
    const connectedUsers = response.data.map((u: any) => ({ ...u, startedAt: new Date(u.startedAt) })) as ConnectedUser[];

    return connectedUsers;
  }

  public async connectUserByPublicKey({ connectedUserPublicKey, privateKey, connectedUsers }:
    { connectedUserPublicKey: string, connectedUsers: ConnectedUser[] } & Partial<UserKeys>): Promise<ConnectedUser> {
    // TODO: check public key length
    const found = connectedUsers.find((u) => u.publicKey === connectedUserPublicKey);
    if (found) {
      return found; // already connected
    }

    // IMPO: caching!
    this.silentCacheUser({ toCacheUserPublicKey: connectedUserPublicKey });

    const tempConnectedUser: ConnectedUser = {
      startedAt: new Date(Date.now()),
      publicKey: connectedUserPublicKey,
    };

    connectedUsers.unshift(tempConnectedUser);
    try {
      await this.skynetClient.db.setJSON(
        privateKey,
        this.userConnectedUsersSkydbKey,
        connectedUsers,
        undefined,
        {
          timeout: this.skydbTimeout,
        },
      );
    } catch (error) {
      throw new Error('Could not connect');
    }

    return tempConnectedUser;
  }

  public async unconnectUserByPublicKey({ connectedUserPublicKey, privateKey, connectedUsers }:
    { connectedUserPublicKey: string, connectedUsers: ConnectedUser[] } & Partial<UserKeys>): Promise<void> {
    // TODO: check public key length

    const foundIndex = connectedUsers.findIndex((u) => u.publicKey === connectedUserPublicKey);
    if (foundIndex === -1) {
      return; // already unconnected
    }

    if (foundIndex > -1) {
      connectedUsers = [
        ...connectedUsers.slice(0, foundIndex),
        ...connectedUsers.slice(foundIndex + 1),
      ];
      try {
        await this.skynetClient.db.setJSON(
          privateKey,
          this.userConnectedUsersSkydbKey,
          connectedUsers,
          undefined,
          {
            timeout: this.skydbTimeout,
          },
        );
      } catch (error) {
        throw new Error('Could not unconnect');
      }
    }
  }

  public async getPublicMemoriesOfConnectedUsers({ connectedUsers }: { connectedUsers: ConnectedUser[] }): Promise<UsersPublicMemories> {
    const connectedUsersMemories: UsersPublicMemories = {};
    for (const fu of connectedUsers) {
      const connectedUserPublicMemories: UserPublicMemory[] = await this.getPublicMemories({ publicKey: fu.publicKey });
      connectedUsersMemories[fu.publicKey] = connectedUserPublicMemories;
    }
    return connectedUsersMemories;
  }

  private async getSharedMemories({ publicKey }: Partial<UserKeys>): Promise<UserSharedMemory[]> {
    let response;
    try {
      response = await this.skynetClient.db.getJSON(
        publicKey,
        this.userSharedMemoriesSkydbKey,
        {
          timeout: this.skydbTimeout,
        },
      );
    } catch (error) {
      response = null;
    }

    if (!response || !('data' in response)) {
      throw new Error('Could not fetch shared memories');
    }

    return response.data as UserSharedMemory[];
  }

  public async shareMemory({ id, memories, publicKey, privateKey, memoriesSkydbKey, memoriesEncryptionKey }:
    { id: string, memories: UserMemory[] } & Partial<UserKeys>): Promise<string> {
    const found = memories.find((memory) => memory.id && memory.id === id);
    if (!found) {
      throw new Error('Memory to share not found');
    }

    if (found.isShared && found.shareLink) {
      return found.shareLink;
    }

    const sharedMemories = await this.getSharedMemories({ publicKey });
    const uniqueEncryptionKey = genKeyPairAndSeed().privateKey;
    const encryptedMemory = cryptoJS.AES.encrypt(JSON.stringify(found), uniqueEncryptionKey);

    const tempSharedMemory: UserSharedMemory = {
      memoryId: found.id,
      sharedId: uuidv4(),
      encryptedMemory: encryptedMemory.toString(),
      encryptionType: EncryptionType.KeyPairFromSeed,
      sharedAt: new Date(Date.now()),
    };

    sharedMemories.unshift(tempSharedMemory);

    try {
      await this.skynetClient.db.setJSON(
        privateKey,
        this.userSharedMemoriesSkydbKey,
        sharedMemories,
        undefined,
        {
          timeout: this.skydbTimeout,
        },
      );
    } catch (error) {
      throw new Error('Could not share memory');
    }

    found.isShared = true;
    const tempSharedMemoryLink: UserSharedMemoryLink = {
      publicKey: publicKey as string,
      sharedId: tempSharedMemory.sharedId,
      encryptionKey: uniqueEncryptionKey,
    };
    found.shareLink = btoa(JSON.stringify(tempSharedMemoryLink));

    await this.storeMemories({ memories, privateKey, memoriesSkydbKey, memoriesEncryptionKey });

    return found.shareLink;
  }

  public async unshareMemory({ id, memories, publicKey, privateKey, memoriesSkydbKey, memoriesEncryptionKey }:
    { id: string, memories: UserMemory[] } & Partial<UserKeys>): Promise<void> {
    await this.deleteFromSharedMemories({ id, publicKey, privateKey });

    const found = memories.find((memory) => memory.id && memory.id === id);
    if (found) {
      delete found.isShared;
      delete found.shareLink;
      await this.storeMemories({ memories, privateKey, memoriesSkydbKey, memoriesEncryptionKey });
    }
  }


  public async resolveMemoryFromBase64(base64Data: string): Promise<UserMemory> {
    try {
      const decodedBase64 = atob(base64Data);
      const memoryLink = JSON.parse(decodedBase64) as UserSharedMemoryLink;
      const sharedMemories = await this.getSharedMemories({ publicKey: memoryLink.publicKey });
      const found = sharedMemories.find((m) => m.sharedId && m.sharedId.search(memoryLink.sharedId) > -1);
      if (!found) {
        throw new Error('Shared memory not found');
      }
      const decryptedMemory = cryptoJS.AES.decrypt(found.encryptedMemory, memoryLink.encryptionKey).toString(cryptoJS.enc.Utf8);
      const parsedDecryptedMemory = JSON.parse(decryptedMemory);
      return parsedDecryptedMemory;
    } catch (error) {
      throw new Error('Memories could not be resolved');
    }
  }

  public resolvePublicKeyFromBase64(base64Data: string): string {
    try {
      const decodedBase64 = atob(base64Data);
      const memoryLink = JSON.parse(decodedBase64) as UserSharedMemoryLink;
      return memoryLink.publicKey;
    } catch (error) {
      throw new Error('PublicKey could not be resolved');
    }
  }

  private async getCachedUsersFromSkyDB(): Promise<CachedUsers> {
    let response;
    try {
      response = await this.skynetClient.db.getJSON(
        this.publicSkybrainSkyDBKey.substr(this.publicSkybrainSkyDBKey.length - 64),
        this.skyBrainSkyDBCachedUsersKey,
        { timeout: this.skydbTimeout },
      );
    } catch (error) {
      response = null;
      throw new Error(
        'Could not fetch SkyBrain cached users'
      );
    }

    if (!response || !('data' in response)) {
      throw new Error('Could not fetch SkyBrain cached users');
    }

    return response.data as CachedUsers;
  }

  private async silentCacheUser({ toCacheUserPublicKey, user }: { toCacheUserPublicKey: string, user?: UserData }) {
    if (!toCacheUserPublicKey || toCacheUserPublicKey.length != 64) {
      return;
    }

    try {
      let userData = user;
      if (!userData) {
        userData = await this.getBrainData({ publicKey: toCacheUserPublicKey });
      }

      if (this.userAlreadyCachedAndUpToDate({ publicKey: toCacheUserPublicKey, user: userData })) {
        return;
      }


      const cachedUser: CachedUser = {
        nickname: userData.nickname,
        description: userData.description,
        cachedAt: new Date(Date.now()),
      }

      this.cacheUserInLocalstorage({ publicKey: toCacheUserPublicKey, user: cachedUser, updatePull: false });

      clearTimeout(this.chacheTimeout);
      this.chacheTimeout = setTimeout(() => {
        this.syncCachedUsers();
      }, 3000);
    } catch (error) {
      console.log("Could not update cached users.");
    }
  }

  public async syncCachedUsers() {
    const localCachedUsers = this.getLocalCachedUsers();
    if (!localCachedUsers) {
      return;
    }

    let skyDBCachedUsers: CachedUsers = {};
    try {
      skyDBCachedUsers = await this.getCachedUsersFromSkyDB();
    } catch (error) {}

    let callSkyDB = false;
    for (let cachedUserPublicKey in localCachedUsers.cache) {
      let cachedUser = localCachedUsers.cache[cachedUserPublicKey];
      if (cachedUserPublicKey in skyDBCachedUsers) {
        const storedCachedUser = skyDBCachedUsers[cachedUserPublicKey];
        if (cachedUser.cachedAt > storedCachedUser.cachedAt) {
          if (cachedUser.description !== storedCachedUser.description ||
            cachedUser.nickname !== storedCachedUser.nickname) {
            skyDBCachedUsers[cachedUserPublicKey] = cachedUser;
            callSkyDB = true;
          }
        }
      } else {
        skyDBCachedUsers[cachedUserPublicKey] = cachedUser;
        callSkyDB = true;
      }
    }

    // Updating the localStorage with cache from SkyDB
    for (let skyDbCachedUserPublicKey in skyDBCachedUsers) {
      if (!(skyDbCachedUserPublicKey in localCachedUsers)) {
        const skyDBCachedUser = skyDBCachedUsers[skyDbCachedUserPublicKey];
        this.cacheUserInLocalstorage({ publicKey: skyDbCachedUserPublicKey, user: skyDBCachedUser, updatePull: true });
      }
    }

    if (!callSkyDB) {
      return;
    }

    await this.skynetClient.db.setJSON(
      this.publicSkybrainSkyDBKey,
      this.skyBrainSkyDBCachedUsersKey,
      skyDBCachedUsers,
      undefined,
      { timeout: this.skydbTimeout }
    );
  }

  private userAlreadyCachedAndUpToDate({ publicKey, user }: { user: UserData } & Partial<UserKeys>): Boolean {
    if (!publicKey) {
      throw new Error('userAlreadyCachedAndUpToDate: invalid publicKey');;
    }

    const localCachedUsers = this.getLocalCachedUsers();
    if (localCachedUsers) {
      if (publicKey in localCachedUsers.cache) {
        if (localCachedUsers.cache[publicKey].nickname === user.nickname &&
          localCachedUsers.cache[publicKey].description === user.description) {
          return true;
        }
      }
    }

    return false;
  }

  private cacheUserInLocalstorage({ publicKey, user, updatePull }:
    { user: CachedUser, updatePull: boolean } & Partial<UserKeys>) {
    if (!publicKey) {
      throw new Error('cacheUserInLocalstorage: invalid publicKey');;
    }

    const localCachedUsers = this.getLocalCachedUsers();
    if (updatePull) {
      localCachedUsers.lastPullAt = this.unixTimestampSeconds();
    }

    localCachedUsers.cache[publicKey] = user;
    localStorage.setItem(this.cachedUsersLocalStorageKey, JSON.stringify(localCachedUsers));
  }

  public unixTimestampSeconds(): number {
    return Math.round(+new Date() / 1000);
  }

  public getLocalCachedUsers(): UsersCache {
    let localCachedUsers = {} as UsersCache;
    localCachedUsers.lastPullAt = 0;
    localCachedUsers.cache = {} as CachedUsers;

    try {
      const fromStorage = localStorage.getItem(this.cachedUsersLocalStorageKey);
      if (fromStorage) {
        localCachedUsers = JSON.parse(fromStorage) as UsersCache;
      }
    } catch (error) { }

    return localCachedUsers;
  }

  public async getStreamMemories(): Promise<StreamMemory[]> {
    let response;
    try {
      response = await this.skynetClient.db.getJSON(
        this.publicSkybrainSkyDBKey.substr(this.publicSkybrainSkyDBKey.length - 64),
        this.streamMemoriesSkydbKey,
        {
          timeout: this.skydbTimeout,
        },
      );
    } catch (error) {
    }
    if (!response || !('data' in response)) {
      throw new Error(
        'Could not fetch stream memories'
      );
    }

    const responseStreamMemories = response.data as StreamMemories;

    // TODO: create cron to do it on backend side. Lambda???
    const dayInMilliseconds = 1 * 1000 * 60 * 60 * 24 * 10;
    if (responseStreamMemories) {
      if (Date.now() - new Date(responseStreamMemories.lastProcessDate).getTime() > dayInMilliseconds) {
        return this.processStreamMemories();
      }
      return responseStreamMemories.memories;
    }

    return [];
  }

  public async processStreamMemories(): Promise<StreamMemory[]> {
    const skyDBCachedUsers = await this.getCachedUsersFromSkyDB();
    let memories: StreamMemory[] = []

    for (let skyDbCachedUserPublicKey in skyDBCachedUsers) {
      const tempMemories = await this.getPublicMemories({ publicKey: skyDbCachedUserPublicKey })
      if (tempMemories) {
        tempMemories.forEach((m) => {
          let tempMemory: StreamMemory = { ...m.memory, ownerPublicKey: skyDbCachedUserPublicKey }
          memories.push(tempMemory)
        })
      }
    }

    const sorted = memories.sort((a, b) => b.added.getTime() - a.added.getTime())

    const processedMemories: StreamMemories = {
      memories: sorted,
      lastProcessDate: new Date(Date.now()),
    }

    await this.skynetClient.db.setJSON(
      this.publicSkybrainSkyDBKey,
      this.streamMemoriesSkydbKey,
      processedMemories,
      undefined,
      { timeout: this.skydbTimeout }
    );

    return sorted;
  }
}
