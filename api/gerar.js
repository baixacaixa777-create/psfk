// Opt-in explícito: o runtime deve transmitir, não acumular os ~6,8 MB.
export const config = { maxDuration: 60 };

module.exports = require('../lib/handlers').gerar;
