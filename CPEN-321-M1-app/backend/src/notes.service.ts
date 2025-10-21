import mongoose from 'mongoose';
import { Note, CreateNoteRequest, NoteType, UpdateNoteRequest } from './notes.types';
import { noteModel } from './note.model';
import OpenAI from 'openai';
import { workspaceModel } from './workspace.model';


export class NoteService {
    private client?: OpenAI;

    private getClient(): OpenAI {
        if (!this.client) {
            this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        }
        return this.client;
    }

    async createNote(userId: mongoose.Types.ObjectId, data: CreateNoteRequest): Promise<Note> {
        let vectorInput = "";

        for (const field of data.fields) {
            if ('content' in field) {
                vectorInput += field.content + " ";
            } else if ('dateTime' in field) {
                vectorInput += field.dateTime.toString() + " ";
            }
        }

        let vectorData: number[] = [];
        
        try {
            if (vectorInput.trim().length > 0) {
                const vectorResponse = await this.getClient().embeddings.create({
                    model: "text-embedding-3-small",
                    input: vectorInput.trim(),
                });
                vectorData = vectorResponse.data[0].embedding;
            }
        } catch (error) {
            console.error('Failed to generate embeddings (continuing with empty vector):', error);
            // Continue with empty vector instead of failing
        }

        const newNote = await noteModel.create({
            userId,
            workspaceId: data.workspaceId,
            fields: data.fields,
            noteType: data.noteType || NoteType.CONTENT,
            tags: data.tags || [],
            authors: [userId],
            vectorData: vectorData,
        });
    
        return {
            ...newNote.toObject(),
            _id: newNote._id.toString(),
            userId: newNote.userId.toString(),
            authors: newNote.authors.map(id => id.toString()),
        } as Note;
    }

    // Update a note
    async updateNote(noteId: string, userId: mongoose.Types.ObjectId, updateData: UpdateNoteRequest): Promise<Note> {
        const updatedNote = await noteModel.findOneAndUpdate(
            { _id: noteId, userId },
            { 
                ...updateData,
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!updatedNote) {
            throw new Error('Note not found');
        }

        return {
            ...updatedNote.toObject(),
            _id: updatedNote._id.toString(),
            userId: updatedNote.userId.toString(),
            authors: updatedNote.authors?.map(id => id.toString()),
        } as Note;
    }

    // Delete a note
    async deleteNote(noteId: string, userId: mongoose.Types.ObjectId): Promise<Note> {
        const deletedNote = await noteModel.findOneAndDelete({ _id: noteId, userId });

        if (!deletedNote) {
            throw new Error('Note not found');
        }

        return {
            ...deletedNote.toObject(),
            _id: deletedNote._id.toString(),
            userId: deletedNote.userId.toString(),
            authors: deletedNote.authors?.map(id => id.toString()),
        } as Note;
    }

    async getNote(noteId: string, userId: mongoose.Types.ObjectId): Promise<Note | null> {
        const note = await noteModel.findOne({ _id: noteId, userId });
        return note ? {
            ...note.toObject(),
            _id: note._id.toString(),
            userId: note.userId.toString(),
            authors: note.authors?.map(id => id.toString()),
        } as Note : null;
    }


    async getAuthors(noteId: string): Promise<any[]> {
        const note = await noteModel.findById(noteId).populate('authors', 'name email profilePicture');
        
        if (!note) {
            throw new Error('Note not found');
        }

        return note.authors as any[];
    }

    // Share note to a different workspace
    async shareNoteToWorkspace(noteId: string, userId: mongoose.Types.ObjectId, workspaceId: string): Promise<Note> {
        // Verify note exists and the requester is the owner of the note
        const note = await noteModel.findById(noteId);
        if (!note) {
            throw new Error('Note not found');
        }
        if (note.userId.toString() !== userId.toString()) {
            throw new Error('Access denied: Only the note owner can share');
        }

        // Verify target workspace exists and the user is allowed (owner or member and not banned)
        const workspace = await workspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new Error('Workspace not found');
        }

        const isMember = workspace.members.some(memberId => memberId.toString() === userId.toString());
        const isBanned = workspace.bannedMembers?.some(id => id.toString() === userId.toString());

        if (isBanned) {
            throw new Error('Access denied: You are banned from this workspace');
        }

        if (!isMember) {
            throw new Error('Access denied: You are not a member of this workspace');
        }
        const updatedNote = await noteModel.findOneAndUpdate(
            { _id: noteId, userId },
            { workspaceId },
            { new: true }
        );

        if (!updatedNote) {
            throw new Error('Note not found');
        }

        return {
            ...updatedNote.toObject(),
            _id: updatedNote._id.toString(),
            userId: updatedNote.userId.toString(),
            authors: updatedNote.authors?.map(id => id.toString()),
        } as Note;
    }

    // Get workspace for a note
    async getWorkspacesForNote(noteId: string): Promise<string | null> {
        const note = await noteModel.findById(noteId);
        
        if (!note) {
            throw new Error('Note not found');
        }

        return note.workspaceId;
    }

    // Get notes for a user with filters
    async getNotes(
        userId: mongoose.Types.ObjectId,
        workspaceId: string,
        noteType: string,
        tags: string[],
        queryString: string
    ): Promise<Note[]> {
        // First verify user has access to this workspace
        const workspace = await workspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new Error('Workspace not found');
        }

        const isMember = workspace.members.some(memberId => memberId.toString() === userId.toString());

        if (!isMember) {
            throw new Error('Access denied: You are not a member of this workspace');
        }

        const query: any = { 
            workspaceId,
            noteType
        };

        if (tags.length > 0) {
            query.tags = { $all: tags };
        }

        const notes = await noteModel.find(query).sort({ createdAt: -1 });

        // If query string is empty, return as-is (mapped)
        if (queryString.trim().length === 0) {
            return notes.map(note => ({
                ...note.toObject(),
                _id: note._id.toString(),
                userId: note.userId.toString(),
                authors: note.authors?.map(id => id.toString()),
            } as Note));
        }

        // Generate embedding for the query and rank notes by cosine similarity
        let queryEmbedding: number[] = [];

        const vectorResponse = await this.getClient().embeddings.create({
            model: "text-embedding-3-small",
            input: queryString.trim(),
        });
        queryEmbedding = vectorResponse.data[0].embedding as unknown as number[];

        
        const cosineSimilarity = (a: number[], b: number[]): number => {
            const len = Math.min(a.length, b.length);
            if (len === 0) return -1;
            let dot = 0;
            let normA = 0;
            let normB = 0;
            for (let i = 0; i < len; i++) {
                const va = a[i];
                const vb = b[i];
                dot += va * vb;
                normA += va * va;
                normB += vb * vb;
            }
            if (normA === 0 || normB === 0) return -1;
            return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        };

        const notesWithScores = notes.map(n => ({
            note: n,
            score: Array.isArray(n.vectorData) && n.vectorData.length > 0
                ? cosineSimilarity(queryEmbedding, n.vectorData as unknown as number[])
                : -1,
        }));

        notesWithScores.sort((a, b) => b.score - a.score);

        return notesWithScores.map(({ note }) => ({
            ...note.toObject(),
            _id: note._id.toString(),
            userId: note.userId.toString(),
            authors: note.authors?.map(id => id.toString()),
        } as Note));
    }

    // Delete all notes in a workspace
    async deleteNotesByWorkspaceId(workspaceId: string): Promise<void> {
        await noteModel.deleteMany({ workspaceId });
    }

}

export const noteService = new NoteService();