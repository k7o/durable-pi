// What more than one job module needs: the App State folder every result is saved under, the shell helpers two
// jobs share, and truncation. A job module carries its own phases and nothing else.
export const RESULT_ROOT = "jobs";

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** A command in the run's folder; the recorded label says which folder when it is not the working directory. */
export const inDir = (dir: string, command: string) => (dir === "." ? command : `cd ${q(dir)} && ${command}`);
export const label = (dir: string, command: string) => (dir === "." ? command : `${command}  (in ${dir})`);
