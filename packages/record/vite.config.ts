import path from 'path';
import config from '../../vite.config.default';

const disableWorkerInlining = process.env.DISABLE_WORKER_INLINING === 'true';
const makePostcssExternal = process.env.MAKE_POSTCSS_EXTERNAL === 'true';

function modifyCode(code) {
    if (makePostcssExternal) {
        // Remove the postcss import
        code = code.replace(/import\s+.*?"postcss";\s*/g, '');
    }
    if (disableWorkerInlining) {
        // **NOTE** If we ever intend to enable canvas recording, this will need to be removed or modified
        // Remove the inlined Worker constructor and replace with noop. This code only gets called when canvas
        // recording is enabled, which we currently do not support enabling.
        code = code.replace(/new\s+Worker\s*\([^)]*\)/g, 'function(){return{onerror:null,onmessage:null}}');
    }

    return code;
}

export default config(
    path.resolve(__dirname, 'src/index.ts'),
    'rrweb',
    {
        plugins: [
            {
                name: '',
                enforce: 'post',
                transform(code, id) {
                    if (!disableWorkerInlining && !makePostcssExternal) return;
                    if (/\.(js|ts|jsx|tsx)$/.test(id)) {
                        return {
                            code: modifyCode(code),
                            map: null,
                        };
                    }
                }
            }
        ]
    }
);
