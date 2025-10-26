import mongoose from 'mongoose';
import { Note, CreateNoteRequest, NoteType, UpdateNoteRequest } from './notes.types';
import { noteModel } from './note.model';
import OpenAI from 'openai';
import { workspaceModel } from './workspace.model';
import { workspaceService } from './workspace.service';


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
            vectorInput += "field label: " + field.label + " ";
            if ('content' in field) {
                vectorInput += "field content: " + field.content + " ";
            }
        }

        let vectorData: number[] = [];
        
        try {
            if (vectorInput.trim().length > 0) {
                const vectorResponse = await this.getClient().embeddings.create({
                    model: "text-embedding-3-large",
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
            vectorData: vectorData,
        });

        // Update workspace timestamp if this is a chat message
        if (data.noteType === NoteType.CHAT) {
            await workspaceService.updateLatestChatMessageTimestamp(data.workspaceId);
        }
    
        return {
            ...newNote.toObject(),
            _id: newNote._id.toString(),
            userId: newNote.userId.toString(),
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
        } as Note;
    }

    async getNote(noteId: string, userId: mongoose.Types.ObjectId): Promise<Note | null> {
        const note = await noteModel.findOne({ _id: noteId, userId });
        return note ? {
            ...note.toObject(),
            _id: note._id.toString(),
            userId: note.userId.toString(),
        } as Note : null;
    }


    async getAuthors(noteIds: string[]): Promise<any[]> {
        if (!noteIds || noteIds.length === 0) {
            return [];
        }

        // Convert note IDs to ObjectIds
        const objectIds = noteIds.map(id => new mongoose.Types.ObjectId(id));
        
        // Fetch all notes
        const notes = await noteModel.find({ _id: { $in: objectIds } });
        
        // Extract user IDs from the notes (in order)
        const userIds = notes.map(note => note.userId);
        
        // Fetch all users using mongoose model directly
        const User = mongoose.model('User');
        const users = await User.find({ _id: { $in: userIds } });

        // Return users in the same order as the notes
        return users;
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
        } as Note;
    }

    // Copy note to a different workspace
    async copyNoteToWorkspace(noteId: string, userId: mongoose.Types.ObjectId, workspaceId: string): Promise<Note> {
        // Verify note exists and the requester is the owner of the note
        const note = await noteModel.findById(noteId);
        if (!note) {
            throw new Error('Note not found');
        }
        if (note.userId.toString() !== userId.toString()) {
            throw new Error('Access denied: Only the note owner can copy');
        }

        // Verify target workspace exists and the user is allowed (owner or member and not banned)
        const workspace = await workspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new Error('Workspace not found');
        }
        const isMember = workspace.members.some(memberId => memberId.toString() === userId.toString());
        const isOwner = workspace.ownerId.toString() === userId.toString();
        if (!isMember && !isOwner) {
            throw new Error('Access denied: User must be a member or owner of the workspace');
        }

        // Create a copy of the note
        const noteCopy = new noteModel({
            userId: note.userId,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            dateCreation: new Date(),
            dateLastEdit: new Date(),
            tags: note.tags,
            noteType: NoteType.CONTENT,
            fields: note.fields,
            vectorData: note.vectorData
        });

        await noteCopy.save();

        return {
            ...noteCopy.toObject(),
            _id: noteCopy._id.toString(),
            userId: noteCopy.userId.toString(),
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
            query.tags = { $in: tags };
        }

        const notes = await noteModel.find(query).sort({ createdAt: -1 });

        // If query string is empty, return as-is (mapped)
        if (queryString.trim().length === 0) {
            return notes.map(note => ({
                ...note.toObject(),
                _id: note._id.toString(),
                userId: note.userId.toString(),
            } as Note));
        }

        // Generate embedding for the query and rank notes by cosine similarity
        let queryEmbedding: number[] = [];

        const vectorResponse = await this.getClient().embeddings.create({
            model: "text-embedding-3-large",
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
        } as Note));
    }

    // Delete all notes in a workspace
    async deleteNotesByWorkspaceId(workspaceId: string): Promise<void> {
        await noteModel.deleteMany({ workspaceId });
    }

}

export const noteService = new NoteService();