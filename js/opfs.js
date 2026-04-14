/**
 * OPFS-backed persistence layer.
 * Directory layout:
 *   djplanner/
 *     project.json   — track metadata, positions, automation
 *     audio/
 *       <trackId>.bin  — raw audio file bytes
 */

const ROOT_DIR = "djplanner";
const AUDIO_DIR = "audio";
const PROJECT_FILE = "project.json";

async function getRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function getAudioDir() {
  const root = await getRoot();
  return root.getDirectoryHandle(AUDIO_DIR, { create: true });
}

/** Check if OPFS is available in this browser/context. */
export async function isAvailable() {
  try {
    if (!navigator?.storage?.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

/** Save raw audio bytes for a track. Returns true on success. */
export async function saveAudio(trackId, arrayBuffer) {
  try {
    const dir = await getAudioDir();
    const fh = await dir.getFileHandle(`${trackId}.bin`, { create: true });
    const writable = await fh.createWritable();
    await writable.write(arrayBuffer);
    await writable.close();
    return true;
  } catch (err) {
    console.error("OPFS saveAudio failed:", err);
    return false;
  }
}

/** Load raw audio bytes for a track. Returns ArrayBuffer or null. */
export async function loadAudio(trackId) {
  try {
    const dir = await getAudioDir();
    const fh = await dir.getFileHandle(`${trackId}.bin`);
    const file = await fh.getFile();
    return file.arrayBuffer();
  } catch {
    return null;
  }
}

/** Delete audio file for a track. */
export async function deleteAudio(trackId) {
  try {
    const dir = await getAudioDir();
    await dir.removeEntry(`${trackId}.bin`);
  } catch {
    // ignore if not found
  }
}

/** Save the project metadata JSON. */
export async function saveProject(projectData) {
  try {
    const root = await getRoot();
    const fh = await root.getFileHandle(PROJECT_FILE, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(projectData, null, 2));
    await writable.close();
    return true;
  } catch (err) {
    console.error("OPFS saveProject failed:", err);
    return false;
  }
}

/** Load the project metadata JSON. Returns parsed object or null. */
export async function loadProject() {
  try {
    const root = await getRoot();
    const fh = await root.getFileHandle(PROJECT_FILE);
    const file = await fh.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** List all stored track IDs (scans audio directory). */
export async function listStoredTrackIds() {
  try {
    const dir = await getAudioDir();
    const ids = [];
    for await (const [name] of dir.entries()) {
      if (name.endsWith(".bin")) ids.push(name.slice(0, -4));
    }
    return ids;
  } catch {
    return [];
  }
}
