/** @type {import('tailwindcss').Config} */
export default {
    content: ['./entrypoints/**/*.{html,ts,tsx}', './components/**/*.{ts,tsx}'],
    theme: {
        extend: {
            colors: {
                edith: {
                    50: '#eff6ff',
                    100: '#dbeafe',
                    500: '#3b82f6',
                    600: '#2563eb',
                    700: '#1d4ed8',
                    900: '#1e3a8a',
                },
            },
        },
    },
    plugins: [],
};
