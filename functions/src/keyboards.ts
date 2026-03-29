import { Keyboard } from 'grammy';

export const mainMenuCustomKeyboard = (notificationsEnabled: boolean) =>
    new Keyboard()
        .text('⚙️ Изменить фильтры')
        .text(`${notificationsEnabled ? '🔕 Выключить' : '🔔 Включить'} уведомления`)
        .row()
        .text('📊 Статистика')
        .resized();
