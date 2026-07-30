import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import commonjs from 'vite-plugin-commonjs';
import { federation } from '@module-federation/vite';
import { moduleFederationShared } from '@iobroker/adapter-react-v5/modulefederation.admin.config';
import pack from './package.json';

/** Copies the custom-component translations to `admin/custom/i18n/` so the admin can resolve them. */
function copyI18n() {
    return {
        name: 'copy-i18n',
        closeBundle(): void {
            const src = path.resolve('src/i18n');
            const dest = path.resolve('../admin/custom/i18n');
            if (fs.existsSync(src)) {
                fs.mkdirSync(dest, { recursive: true });
                for (const file of fs.readdirSync(src).filter(f => f.endsWith('.json'))) {
                    fs.copyFileSync(path.join(src, file), path.join(dest, file));
                }
            }
        },
    };
}

const config = {
    plugins: [
        federation({
            manifest: true,
            name: 'ConfigCustomAssistantSatellite',
            filename: 'customComponents.js',
            exposes: {
                './Components': './src/Components.tsx',
            },
            remotes: {},
            shared: moduleFederationShared(pack),
            dts: false,
        }),
        react(),
        commonjs(),
        copyI18n(),
    ],
    resolve: {
        tsconfigPaths: true,
    },
    server: {
        port: 3000,
        proxy: {
            '/files': 'http://localhost:8081',
            '/adapter': 'http://localhost:8081',
            '/session': 'http://localhost:8081',
            '/log': 'http://localhost:8081',
            '/lib': 'http://localhost:8081',
        },
    },
    base: './',
    build: {
        target: 'chrome89',
        outDir: '../admin/custom',
        emptyOutDir: true,
        rollupOptions: {
            onwarn(warning: { code: string }, warn: (warning: { code: string }) => void): void {
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                    return;
                }
                warn(warning);
            },
        },
    },
};

export default config;
