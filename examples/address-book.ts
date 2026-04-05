import { Supervisor } from "../packages/core/src/supervisor.ts"
interface Contact {
    email: string;
    name?: string;
    phone?: string;
}

type State = { contacts: Record<string, Contact> }

type Msg = 
| { type: 'addContact'; contact: Contact }
| { type: 'removeContact', email: string, reply: boolean }
| { type: 'getContactInfo', email: string, reply: Contact | null }
| { type: 'listContacts', reply: Contact[] }
| { type: 'updateContact', email: string, updatedInfo: Partial<Contact>, reply: Contact | null }
| { type: 'clearContacts' }

const system = new Supervisor({handleCrash: async (e) => console.error(e)});

const server = system.spawnServer<State, Msg>({
    initialState: { contacts: {} },
    handlers: {
        addContact: (state, msg) => ({...state, contacts: {...state.contacts, [msg.contact.email]: msg.contact}}),
        removeContact: (state, msg) => {
            const exists = state.contacts[msg.email] !== undefined;
            const { [msg.email]: _, ...rest } = state.contacts;
            return {state: { ...state, contacts: rest }, reply: exists};
        },
        getContactInfo: (state, msg) => ({ state, reply: state.contacts[msg.email] ??        null }),
        listContacts: (state) => ({ state, reply: Object.values(state.contacts) }),
        updateContact: (state, msg) => {
            const existing = state.contacts[msg.email];
            if (!existing) return { state, reply: null };
            const updated = { ...existing, ...msg.updatedInfo };
            return { state: { ...state, contacts: { ...state.contacts, [msg.email]: updated } }, reply: updated };
        },
        clearContacts: (state) => ({ ...state, contacts: {} })
    }
});

const contactAsync = async () => {
    server.cast({ type: 'addContact', contact: { email: 'john.doe@example.com', name: 'John Doe', phone: '123-456-7890' } });
    const contactInfo = await server.call({ type: 'getContactInfo', email: 'john.doe@example.com' });

    console.log('Contact info for John Doe:', contactInfo);

    server.cast({ type: 'addContact', contact: { email: 'jane.doe@example.com', name: 'Jane Doe', phone: '987-654-3210' } });

    const allContacts = await server.call({ type: 'listContacts' });

    console.log('All contacts:', allContacts);

    const updatedContact = await server.call({ type: 'updateContact', email: 'john.doe@example.com', updatedInfo: { phone: '111-222-3333' } });

    console.log('Updated contact info for John Doe:', updatedContact);

    const removed = await server.call({ type: 'removeContact', email: 'jane.doe@example.com' });

    console.log('Removed Jane Doe:', removed);
    const finalContacts = await server.call({ type: 'listContacts' });

    console.log('Final contacts:', finalContacts);
};

contactAsync();
