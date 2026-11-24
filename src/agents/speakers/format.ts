/**
 * How a speaker appears in any CLI output: the name, then the id the other commands take, so a line is both
 * readable and usable ("Ana Pires (6a1f...)"). One place, so no command prints a bare id or a bare name.
 */
export const who = (name: string, id: string): string => `${name} (${id})`;
