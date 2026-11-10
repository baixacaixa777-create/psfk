// Opt-in explícito: o runtime deve transmitir, não acumular os ~6,8 MB.
export const config = { supportsResponseStreaming: true, maxDuration: 60 };

export default require('../lib/handlers').pagina;
