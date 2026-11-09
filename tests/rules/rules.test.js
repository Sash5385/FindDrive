// Тести firestore.rules (F1 чати, F2 рейтинг, F3 email_verified, відгуки).
// Запуск: cd tests/rules && npm install && npm test
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, addDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';

let env;
const INSTR = 'instrA';
const STUDENT = 'stu1';
const CHAT = `${INSTR}_${STUDENT}`;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-finddrive',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    // інструктор прив'язаний лише за email (userId ще не заклеймлено)
    await setDoc(doc(db, 'instructors', INSTR), { name: 'A', email: 'instr@x.ua', userId: null, status: 'approved', rating: 4, reviews: 1 });
    await setDoc(doc(db, 'instructors', 'instrB'), { name: 'B', email: 'b@x.ua', userId: 'uidB', status: 'approved', rating: null, reviews: 0 });
    await setDoc(doc(db, 'chats', CHAT), { instrId: INSTR, studentId: STUDENT, instrUserId: null, instrEmail: 'instr@x.ua' });
    await setDoc(doc(db, 'chats', CHAT, 'messages', 'm1'), { text: 'hi', from: 'student', uid: STUDENT });
    await setDoc(doc(db, 'bookings', 'bk1'), { clientId: STUDENT, instructorId: INSTR, status: 'confirmed' });
    await setDoc(doc(db, 'bookings', 'bk2'), { clientId: STUDENT, instructorId: INSTR, status: 'pending' });
  });
});

const as = (uid, token = {}) => env.authenticatedContext(uid, token).firestore();
const student = () => as(STUDENT, { email: 'stu@x.ua', email_verified: true });
const stranger = () => as('evil', { email: 'evil@x.ua', email_verified: true });
const instrVerified = () => as('uidA', { email: 'instr@x.ua', email_verified: true });
const instrSpoof = () => as('spoof', { email: 'instr@x.ua', email_verified: false });
const msg = (uid, from, text = 'привіт') => ({ text, from, uid, senderName: 'x', at: serverTimestamp() });

// ── F1: чати ──
test('F1: чужий не читає повідомлення', () => assertFails(getDocs(collection(stranger(), 'chats', CHAT, 'messages'))));
test('F1: чужий не пише в чужий чат', () => assertFails(addDoc(collection(stranger(), 'chats', CHAT, 'messages'), msg('evil', 'student'))));
test('F1: учень читає свій чат', () => assertSucceeds(getDocs(collection(student(), 'chats', CHAT, 'messages'))));
test('F1: учень пише в свій чат', () => assertSucceeds(addDoc(collection(student(), 'chats', CHAT, 'messages'), msg(STUDENT, 'student'))));
test('F1: не можна писати від чужого uid', () => assertFails(addDoc(collection(student(), 'chats', CHAT, 'messages'), msg('other', 'student'))));
test('F1: ліміт довжини повідомлення', () => assertFails(addDoc(collection(student(), 'chats', CHAT, 'messages'), msg(STUDENT, 'student', 'x'.repeat(2001)))));
test('F1: інструктор (верифікований email) читає чат', () => assertSucceeds(getDocs(collection(instrVerified(), 'chats', CHAT, 'messages'))));
test('F3: неверифікований email інструктора не читає чат', () => assertFails(getDocs(collection(instrSpoof(), 'chats', CHAT, 'messages'))));
test('F1: list чатів за instrEmail (верифікований)', () => assertSucceeds(getDocs(query(collection(instrVerified(), 'chats'), where('instrEmail', '==', 'instr@x.ua')))));
test('F3: list чатів за instrEmail (неверифікований)', () => assertFails(getDocs(query(collection(instrSpoof(), 'chats'), where('instrEmail', '==', 'instr@x.ua')))));
test('F1: list своїх чатів учнем', () => assertSucceeds(getDocs(query(collection(student(), 'chats'), where('studentId', '==', STUDENT)))));

test('F1: учень створює чат з правильним id і полями', () => assertSucceeds(setDoc(doc(as('stu2'), 'chats', 'instrB_stu2'),
  { instrId: 'instrB', studentId: 'stu2', instrUserId: 'uidB', instrEmail: 'b@x.ua', instrName: 'B', studentName: 's', unreadByStudent: 0 }, { merge: true })));
test('F1: не можна створити чат з підміненим instrEmail', () => assertFails(setDoc(doc(as('stu2'), 'chats', 'instrB_stu2'),
  { instrId: 'instrB', studentId: 'stu2', instrUserId: 'uidB', instrEmail: 'stu2@x.ua' })));
test('F1: не можна створити чат за іншого учня', () => assertFails(setDoc(doc(stranger(), 'chats', 'instrB_victim'),
  { instrId: 'instrB', studentId: 'victim', instrUserId: 'uidB', instrEmail: 'b@x.ua' })));
test('F1: інструктор створює чат з учнем (дошка)', () => assertSucceeds(setDoc(doc(as('uidB'), 'chats', 'instrB_stu9'),
  { instrId: 'instrB', studentId: 'stu9', instrUserId: 'uidB', instrEmail: 'b@x.ua' }, { merge: true })));
test('F1: учень оновлює lastMessage', () => assertSucceeds(setDoc(doc(student(), 'chats', CHAT), { lastMessage: 'x', lastAt: serverTimestamp() }, { merge: true })));
test('F1: учень не переписує studentId', () => assertFails(updateDoc(doc(student(), 'chats', CHAT), { studentId: 'evil' })));

// ── F2: рейтинг ──
test('F2: чужий не змінює rating', () => assertFails(updateDoc(doc(stranger(), 'instructors', 'instrB'), { rating: 5, reviews: 100 })));
test('F2: власник не змінює свій rating', () => assertFails(updateDoc(doc(as('uidB'), 'instructors', 'instrB'), { rating: 5 })));
test('F2: власник змінює інші поля', () => assertSucceeds(updateDoc(doc(as('uidB'), 'instructors', 'instrB'), { about: 'hi' })));
test('F2: власник не ставить собі verified', () => assertFails(updateDoc(doc(as('uidB'), 'instructors', 'instrB'), { verified: true })));
test('F2: create з rating заборонено', () => assertFails(addDoc(collection(as('n1'), 'instructors'), { status: 'pending', userId: 'n1', rating: 5, reviews: 10 })));
test('F2: звичайний create працює', () => assertSucceeds(addDoc(collection(as('n1'), 'instructors'), { status: 'pending', userId: 'n1', rating: null, reviews: 0 })));
test('F2: create на чужий userId заборонено', () => assertFails(addDoc(collection(as('n1'), 'instructors'), { status: 'pending', userId: 'other', rating: null, reviews: 0 })));

// ── F3: email_verified ──
test('F3: неверифікований не читає бронь інструктора', () => assertFails(getDoc(doc(instrSpoof(), 'bookings', 'bk1'))));
test('F3: верифікований інструктор читає бронь', () => assertSucceeds(getDoc(doc(instrVerified(), 'bookings', 'bk1'))));
test('F3: неверифікований не клеймить userId', () => assertFails(updateDoc(doc(instrSpoof(), 'instructors', INSTR), { userId: 'spoof' })));
test('F3: верифікований клеймить userId на себе', () => assertSucceeds(updateDoc(doc(instrVerified(), 'instructors', INSTR), { userId: 'uidA' })));
test('F3: не можна заклеймити на чужий uid', () => assertFails(updateDoc(doc(instrVerified(), 'instructors', INSTR), { userId: 'other' })));
test('F3: неверифікований sash5385 не адмін', () => assertFails(updateDoc(doc(as('x', { email: 'sash5385@gmail.com', email_verified: false }), 'instructors', INSTR), { status: 'approved' })));

// ── Відгуки ──
const review = (over = {}) => ({ instrId: INSTR, clientId: STUDENT, clientName: 'S', clientPhoto: null, rating: 5, text: 'ok', bookingId: 'bk1', createdAt: serverTimestamp(), ...over });
test('Відгук: валідний', () => assertSucceeds(setDoc(doc(student(), 'reviews', 'bk1'), review())));
test('Відгук: другий на ту саму бронь', async () => {
  await assertSucceeds(setDoc(doc(student(), 'reviews', 'bk1'), review()));
  await assertFails(setDoc(doc(student(), 'reviews', 'bk1'), review({ rating: 1 })));
});
test('Відгук: оцінка 6', () => assertFails(setDoc(doc(student(), 'reviews', 'bk1'), review({ rating: 6 }))));
test('Відгук: непідтверджена бронь', () => assertFails(setDoc(doc(student(), 'reviews', 'bk2'), review({ bookingId: 'bk2' }))));
test('Відгук: без броні', () => assertFails(setDoc(doc(stranger(), 'reviews', 'bk1'), review({ clientId: 'evil' }))));
test('Відгук: на іншого інструктора', () => assertFails(setDoc(doc(student(), 'reviews', 'bk1'), review({ instrId: 'instrB' }))));
