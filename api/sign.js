// api/sign.js

// Importamos la librería nativa de Node.js para criptografía.
const crypto = require('crypto');

// Esta función maneja las peticiones GET desde n8n
export default (req, res) => {
    // 1. Obtener los parámetros de la URL (Query) de n8n
    const { signString, secret } = req.query;

    // 2. Verificar que ambos parámetros estén presentes
    if (!signString || !secret) {
        return res.status(400).send('Error: Faltan los parámetros signString o secret.');
    }

    try {
        // 3. Generar la firma SHA1 (HMAC)
        const signature = crypto.createHmac('sha1', secret)
                                .update(signString)
                                .digest('hex');

        // 4. Devolver la firma a n8n en formato JSON
        res.status(200).json({ signature: signature });
    } catch (error) {
        res.status(500).send('Error al generar la firma: ' + error.message);
    }
};
