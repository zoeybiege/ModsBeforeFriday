import { AdbSync, AdbSyncWriteOptions, Adb, encodeUtf8 } from '@yume-chan/adb';
import { Consumable, ConcatStringStream, TextDecoderStream, MaybeConsumable, ReadableStream } from '@yume-chan/stream-extra';
import { Request, Response, LogMsg, ModStatus, Mods, FixedPlayerData, ImportResult, DowngradedManifest, Patched } from "./Messages";
import { Mod } from './Models';
import { AGENT_SHA1 } from './agent_manifest';
import { toast } from 'react-toastify';

const AgentPath: string = "/data/local/tmp/mbf-agent";

export type LogEventSink = ((event: LogMsg) => void) | null;

// Converts the provided byte array into a ReadableStream that can be fed into ADB.
function readableStreamFromByteArray(array: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(array);
      controller.close();
    },
  });
}

export function logInfo(sink: LogEventSink, msg: string) {
  console.log(msg);
  if(sink !== null) {
    sink({
      type: "LogMsg",
      level: "Info",
      message: msg
    })
  }
}
export async function prepareAgent(adb: Adb, eventSink: LogEventSink) {
  logInfo(eventSink, "Preparing agent: used to communicate with your Quest.");

  let existingUpToDate = false;
  console.log("Latest agent SHA1 " + AGENT_SHA1);

  const exsitingSha1 = (await adb.subprocess.spawnAndWait(`sha1sum ${AgentPath} | cut -f 1 -d " "`)).stdout
    .trim()
    .toUpperCase();
  console.log("Existing agent SHA1: " + exsitingSha1);
  existingUpToDate = AGENT_SHA1 == exsitingSha1.trim().toUpperCase();

  if(existingUpToDate) {
    logInfo(eventSink, "Agent is up to date");
  } else  {
    await overwriteAgent(adb, eventSink);
  }

}

export async function overwriteAgent(adb: Adb, eventSink: LogEventSink) {
  const sync = await adb.sync();
  console.group("Downloading and overwriting agent on Quest");
  try {
    logInfo(eventSink, "Removing existing agent");
    await adb.subprocess.spawnAndWait("rm " + AgentPath)
    logInfo(eventSink, "Downloading agent, this might take a minute if it's not cached")
    await saveAgent(sync, eventSink);
    logInfo(eventSink, "Making agent executable");
    await adb.subprocess.spawnAndWait("chmod +x " + AgentPath);

    logInfo(eventSink, "Agent is ready");
  } finally {
    sync.dispose();
    console.groupEnd();
  }
}

async function saveAgent(sync: AdbSync, eventSink: LogEventSink) {
  // Timeout, in seconds, before the app will treat the agent upload as failed and terminate the connection.
  const AGENT_UPLOAD_TIMEOUT: number = 30;

  const agent: Uint8Array = await downloadAgent(eventSink);

  logInfo(eventSink, "Got bytes, converting into readable stream");
  const file: ReadableStream<MaybeConsumable<Uint8Array>> = readableStreamFromByteArray(agent);

  const options: AdbSyncWriteOptions = {
    filename: AgentPath,
    file
  };

  logInfo(eventSink, "Writing agent to quest!");
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Did not finish pushing agent after ${AGENT_UPLOAD_TIMEOUT} seconds.\n`
        + `In practice, pushing the agent takes less than a second, so this is a bug. Please report this issue including information about `
        + `which web browser you are using.`
    )), AGENT_UPLOAD_TIMEOUT * 1000);
  });

  await Promise.race([timeoutPromise, sync.write(options)])
}
  
async function downloadAgent(eventSink: LogEventSink): Promise<Uint8Array> {
  const MAX_ATTEMPTS: number = 3;
  const PROGRESS_UPDATE_INTERVAL = 1000; // Time between download progress updates, in milliseconds

  let ok = false;
  let attempt = 1;
  do {
    try {
      // Use XMLHttpRequest adapted to work with promises/async to fetch the agent
      // Previously this used the fetch API, and there was some suggestion that various issues regarding the download
      // "hanging" before data was received were caused by fetch.
      // So, to see if it fixes the problem, we have changed to XMLHttpRequest.
      const xhr = new XMLHttpRequest();
      await new Promise((resolve, reject) => {
        xhr.open('GET', "mbf-agent", true);
        xhr.responseType = "arraybuffer";

        xhr.onload = function() {
          if(xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response);
          } else  {
            reject(xhr.status)
          }
        };
        xhr.onerror = function() {
          reject(xhr.status)
        }

        let lastReadTime = new Date().getTime();
        xhr.onprogress = function(event) {
          if(!event.lengthComputable) {
            return;
          }

          // Do not spam with progress updates: only every second or so
          const timeNow = new Date().getTime();
          if(timeNow - lastReadTime > PROGRESS_UPDATE_INTERVAL) {
            // Calculate the percentage of the download that has completed
            const percentComplete = (event.loaded / event.total) * 100.0;
            lastReadTime = timeNow;
            logInfo(eventSink, `Download ${Math.round(percentComplete * 10) / 10}% complete`);
          }
        }

        xhr.send();
      })

      logInfo(eventSink, "Download complete, getting byte array from response");
      return new Uint8Array(xhr.response);
    } catch(e) {
      logInfo(eventSink, "Failed to fetch agent, status " + e);
    }

    attempt++;
    if(attempt <= MAX_ATTEMPTS) {
      logInfo(eventSink, `Failed to download agent, trying again... (attempt ${attempt}/${MAX_ATTEMPTS})`);
    }
  } while(!ok && attempt <= MAX_ATTEMPTS);

  throw new Error("Failed to fetch agent after multiple attempts.\nDid you lose internet connection just after you loaded the site?\n\nIf not, then please report this issue, including a screenshot of the browser console window!");
}

function logFromAgent(log: LogMsg) {
  switch(log.level) {
    case 'Error':
      console.error(log.message);
      break;
    case 'Warn':
      console.warn(log.message);
      break;
    case 'Debug':
      console.debug(log.message);
      break;
    case 'Info':
      console.info(log.message);
      break;
    case 'Trace':
      console.trace(log.message);
  }
}

async function sendRequest(adb: Adb, request: Request, eventSink: LogEventSink = null): Promise<Response> {
  let command_buffer = encodeUtf8(JSON.stringify(request) + "\n");

  let agentProcess = await adb.subprocess.spawn(AgentPath);

  const stdin = agentProcess.stdin.getWriter();
  try {
    stdin.write(new Consumable(command_buffer));
  } finally {
    stdin.releaseLock();
  }

  let exited = false;
  agentProcess.exit.then(() => exited = true);
  adb.disconnected.then(() => exited = true);

  const reader = agentProcess.stdout
    // TODO: Not totally sure if this will handle non-ASCII correctly.
    // Doesn't seem to consider that a chunk might not be valid UTF-8 on its own
    .pipeThrough(new TextDecoderStream())
    .getReader();
  
  console.group("Agent Request");
  let buffer = "";
  let response: Response | null = null;
  while(!exited) {
    const result = await reader.read();
    const receivedStr = result.value;
    if(receivedStr === undefined) {
      continue;
    }

    // TODO: This is fairly inefficient in terms of memory usage
    // (although we aren't receiving a huge amount of data so this might be OK)
    buffer += receivedStr;
    const messages = buffer.split("\n");
    buffer = messages[messages.length - 1];

    for(let i = 0; i < messages.length - 1; i++) {
      // Parse each newline separated message as a Response
      let msg_obj: Response;
      try {
        msg_obj = JSON.parse(messages[i]) as Response;
      } catch(e) {
        throw new Error("Agent message " + messages[i] + " was not valid JSON");
      }
      if(msg_obj.type === "LogMsg") {
        const log_obj = msg_obj as LogMsg;
        logFromAgent(log_obj);
        if(eventSink != null) {
          eventSink(log_obj);
        }

        // Errors need to be thrown later in the function
        if(msg_obj.level === 'Error') {
          response = msg_obj;
        }
      } else  {
        // The final message is the only one that isn't of type `log`.
        // This contains the actual response data
        response = msg_obj;
      }
    }
  }
  console.groupEnd();

  if((await agentProcess.exit) === 0) {
    if(response === null) {
      throw new Error("Received error response from agent");
    } else if(response.type === 'LogMsg') {
      const log = response as LogMsg;
      throw new Error("`" + log.message + "`");
    } else  {
      return response;
    }
  } else  {
    // If the agent exited with a non-zero code then it failed to actually write a response to stdout
    // Alternatively, the agent might be corrupt.
    throw new Error("Failed to invoke agent: is the executable corrupt?" + 
      await agentProcess.stderr
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new ConcatStringStream()))
  }
}

let CORE_MOD_OVERRIDE_URL: string | null = null;
export function setCoreModOverrideUrl(core_mod_override_url: string | null) {
  CORE_MOD_OVERRIDE_URL = core_mod_override_url;
}

// Gets the status of mods from the quest, i.e. whether the app is patched, and what mods are currently installed.
export async function loadModStatus(device: Adb, eventSink: LogEventSink = null): Promise<ModStatus> {
  await prepareAgent(device, eventSink);

  return await sendRequest(device, {
      type: 'GetModStatus',
      override_core_mod_url: CORE_MOD_OVERRIDE_URL,
  }, eventSink) as ModStatus;
}

// Tells the backend to attempt to uninstall/install the given mods, depending on the new install status provided in `changesRequested`.
export async function setModStatuses(device: Adb,
  changesRequested: { [id: string]: boolean },
  eventSink: LogEventSink = null): Promise<Mod[]> {
  let response = await sendRequest(device, {
      type: 'SetModsEnabled',
      statuses: changesRequested
  }, eventSink);

  return (response as Mods).installed_mods;
}

// Gets the AndroidManifest.xml file for the given Beat Saber APK version, converted from AXML to XML.
export async function getDowngradedManifest(device: Adb, gameVersion: string, eventSink: LogEventSink = null): Promise<string> {
  let response = await sendRequest(device, {
    type: 'GetDowngradedManifest',
    version: gameVersion
  }, eventSink);

  return (response as DowngradedManifest).manifest_xml;
}

export async function importFile(device: Adb,
    file: File,
    eventSink: LogEventSink = null): Promise<ImportResult> {
  const sync = await device.sync();
  const tempPath = "/data/local/tmp/mbf-uploads/" + file.name;
  try {
    
    console.log("Uploading to " + tempPath);

    await sync.write({
      filename: tempPath,
      file: readableStreamFromByteArray(new Uint8Array(await file.arrayBuffer()))
    })

    const response = await sendRequest(device, {
      'type': 'Import',
      from_path: tempPath
    }, eventSink);

    return response as ImportResult;
  } finally {
    sync.dispose();
  }
}

export async function importUrl(device: Adb,
url: string,
eventSink: LogEventSink = null) {
  const response = await sendRequest(device, {
    type: 'ImportUrl',
    from_url: url
  }, eventSink);

  return response as ImportResult;
}

export async function removeMod(device: Adb,
  mod_id: string,
  eventSink: LogEventSink = null) {
  let response = await sendRequest(device, {
      type: 'RemoveMod',
      id: mod_id
  }, eventSink);

  return (response as Mods).installed_mods;
}

// Instructs the agent to patch the app, adding the modloader and installing the core mods.
// Updates the ModStatus `beforePatch` to reflect the state of the installation after patching.
// (will not patch if the APK is already modded - will just extract the modloader and install core mods.)
export async function patchApp(device: Adb,
  beforePatch: ModStatus,
  downgradeToVersion: string | null,
  manifestMod: string,
  remodding: boolean,
  allow_no_core_mods: boolean,
  eventSink: LogEventSink = null): Promise<ModStatus> {
  console.log("Patching with manifest", manifestMod);

  let response = await sendRequest(device, {
      type: 'Patch',
      downgrade_to: downgradeToVersion,
      manifest_mod: manifestMod,
      allow_no_core_mods: allow_no_core_mods,
      override_core_mod_url: CORE_MOD_OVERRIDE_URL,
      remodding
  }, eventSink) as Patched;

  if(response.did_remove_dlc) {
    toast.warning("MBF (temporarily) deleted installed DLC while downgrading your game. To get them back, FIRST restart your headset THEN download the DLC in-game.",
        { autoClose: false })
  }

  // Return the new mod status assumed after patching
  // (patching should fail if any of this is not the case)
  return {
      'type': 'ModStatus',
      app_info: {
          loader_installed: 'Scotland2',
          version: downgradeToVersion ?? beforePatch.app_info!.version,
          manifest_xml: manifestMod
      },
      core_mods: {
          all_core_mods_installed: true,
          supported_versions: beforePatch.core_mods!.supported_versions,
          downgrade_versions: []
      },
      modloader_present: true,
      installed_mods: response.installed_mods
  };
}

// Instructs the agent to download and install any missing/outdated core mods, as well as push the modloader to the required location.
// Should fix many common issues with an install.
export async function quickFix(device: Adb,
  beforeFix: ModStatus,
  wipe_existing_mods: boolean,
  eventSink: LogEventSink = null): Promise<ModStatus> {
  let response = await sendRequest(device, {
      type: 'QuickFix',
      override_core_mod_url: CORE_MOD_OVERRIDE_URL,
      wipe_existing_mods
  }, eventSink);

  // Update the mod status to reflect the fixed installation
  return {
      'type': 'ModStatus',
      app_info: beforeFix.app_info,
      core_mods: {
          all_core_mods_installed: true,
          supported_versions: beforeFix.core_mods!.supported_versions,
          downgrade_versions: beforeFix.core_mods!.downgrade_versions
      },
      installed_mods: (response as Mods).installed_mods,
      modloader_present: true
  }
}

// Attempts to fix the black screen issue on Quest 3.
export async function fixPlayerData(device: Adb,
  eventSink: LogEventSink = null): Promise<boolean> {
  let response = await sendRequest(device, { type: 'FixPlayerData' }, eventSink);

  return (response as FixedPlayerData).existed
}
