import { defineConfig } from 'wxt';

export default defineConfig({
    extensionApi: 'chrome',
    manifest: {
        name: 'EDITH',
        description: 'EDITH - Your AI Browser Agent',
        version: '1.0.0',
        permissions: [
            'debugger',
            'sidePanel',
            'storage',
            'tabs',
            'activeTab',
            'scripting',
            'alarms',
            'notifications',
        ],
        host_permissions: ['<all_urls>'],
        side_panel: {
            default_path: 'sidepanel.html',
        },
        action: {
            default_title: 'EDITH',
        },
    },
});
