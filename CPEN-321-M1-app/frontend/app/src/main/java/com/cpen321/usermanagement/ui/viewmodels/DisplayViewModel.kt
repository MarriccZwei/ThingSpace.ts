package com.cpen321.usermanagement.ui.viewmodels

import android.util.Log
import com.cpen321.usermanagement.ui.navigation.NavigationStateManager
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cpen321.usermanagement.data.remote.dto.Note
import com.cpen321.usermanagement.data.remote.dto.NoteType
import com.cpen321.usermanagement.data.repository.WorkspaceRepository
import com.cpen321.usermanagement.data.repository.ProfileRepository
import com.cpen321.usermanagement.data.remote.dto.Workspace
import com.cpen321.usermanagement.data.repository.NoteRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.chunked

@HiltViewModel
open class DisplayViewModel @Inject constructor(
    private val navigationStateManager: NavigationStateManager,
    private val workspaceRepository: WorkspaceRepository,
    private val profileRepository: ProfileRepository,
    private val noteRepository: NoteRepository) : ViewModel() {

    private var _wsname = "personal"
    private var _wsid = "personal"
    private var _wsdescr = ""
    private var _wspic = ""

    private var _notesPerPage = 10

    protected val _fetching = MutableStateFlow<Boolean>(false)
    val fetching: StateFlow<Boolean> =_fetching.asStateFlow()

    protected var _notesFound: List<List<Note>> = emptyList()

    companion object {
        private const val TAG = "DisplayViewModel"
    }

    fun getNotesTitlesFound(page: Int):List<Note>{
        return  if (_notesFound.isEmpty()) emptyList() else _notesFound[page] //TODO: for now
    }

    fun onLoad(){
        _fetching.value = true
        viewModelScope.launch{
            cacheUpdateWorkspaceOrUser(navigationStateManager.getWorkspaceId())
            searchResults()
            _fetching.value=false
        }
    }

    fun getWorkspaceName():String{
        val workspaceId = navigationStateManager.getWorkspaceId()
        viewModelScope.launch{cacheUpdateWorkspaceOrUser(workspaceId)}
        return _wsname //TODO: if "" should move to userId
    }

//    fun searchedNotesUpdate(){
//        //TODO: Add pagination later
//        viewModelScope.launch { searchResults() }
//    }

    private suspend fun cacheUpdateWorkspaceOrUser(workspaceId:String){
            val wsRequest = workspaceRepository.getWorkspace(workspaceId)
            if (wsRequest.isSuccess) {
                val ws: Workspace = wsRequest.getOrNull()!!
                _wsid = workspaceId
                _wsname = ws.profile.name
                _wspic = ws.profile.imagePath ?: ""
                _wsdescr = ws.profile.description ?: ""
            }
            else{
                val personalResult = workspaceRepository.getPersonalWorkspace()
                if (personalResult.isSuccess){
                    val ws = personalResult.getOrNull()!!
                    _wsid = ws._id
                    _wspic = ws.profile.imagePath ?: ""
                    _wsdescr = ws.profile.description ?: ""
                    _wsname = ws.profile.name
                    navigationStateManager.setWorkspaceId(ws._id)
                }
                else
                {
                    val error = personalResult.exceptionOrNull()
                    Log.e(TAG, "Failed to load workspace/profile", error)
                    error?.message ?: "Failed to load workspace/profile"
                }
            }
    }

    protected open suspend fun searchResults(){
        val tags = navigationStateManager.getSelectedTags()

        val noteSearchResult = noteRepository.findNotes( //TODO: Pagination later
            workspaceId = navigationStateManager.getWorkspaceId(),
            noteType = navigationStateManager.getNoteType(),
            searchQuery = navigationStateManager.getSearchQuery(),
            tagsToInclude = tags,
            notesPerPage = _notesPerPage
            )
        if (noteSearchResult.isSuccess){
            val rawNotesFound = noteSearchResult.getOrNull()!!
            _notesFound = rawNotesFound.chunked(_notesPerPage)
        }
        else{
            _notesFound = emptyList()
        }
    }

    suspend fun loadAllUserTags(){
        val tagsRequest = workspaceRepository.getAllTags(
            navigationStateManager.getWorkspaceId())
        if (tagsRequest.isSuccess){
            val allTags = tagsRequest.getOrNull()!!
            navigationStateManager.updateTagSelection(allTags, true)
        }
        else{
            navigationStateManager.updateTagSelection(emptyList(),
                false)
        }
    }
}