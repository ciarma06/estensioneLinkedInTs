/**
 * Dichiarazioni minime per il runtime Deno delle Supabase Edge Functions.
 * Evita "Cannot find name 'Deno'" quando TypeScript del workspace analizza questo file
 * (la cartella non usa il progetto Deno dell'editor).
 */
declare global {
  const Deno: {
    env: { get(key: string): string | undefined };
    serve: (handler: (request: Request) => Response | Promise<Response>) => void;
  };
}

export {};
